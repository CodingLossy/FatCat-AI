// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 本地知识库(ADR 0015):条目同步之后,把授权目录中的文本与文档分块,放进嵌入队列;
// 检索时优先用向量,没有向量(没有 embed 配置档、需要重建、上游失败)时用全文检索兜底。
import { basename, extname } from 'node:path';
import type { KbCitation, KbSearchOutput } from '@ai-personal/shared';
import type { KbChunk, KbChunkInput, Repositories } from '@ai-personal/storage';
import { detectCredential, redactCredentials } from '@ai-personal/memory/secrets';
import { isWithin, type ToolDefinition } from '@ai-personal/tools';
import { z } from 'zod';
import { readAuthorizedFile } from '../files.js';
import { chunkText } from './chunk.js';

export { chunkText, MAX_CHUNKS_PER_FILE } from './chunk.js';

/** 进入知识库的扩展名;其余文件只出现在知识地图中。 */
export const KB_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.pdf', '.docx', '.xlsx']);
const MAX_OUTPUT_CHARS = 12_000;

/** 向量部分由服务器的嵌入服务提供(ADR 0014);不提供时只用全文检索。 */
export interface KbVectors {
    enqueue(ownerId: string, itemId: string, chunk: number, text: string): void;
    /** 返回 null 表示向量不可用。 */
    search(
        ownerId: string,
        query: string,
        k: number,
        signal?: AbortSignal,
    ): Promise<{ itemId: string; chunk: number }[] | null>;
}

export interface KnowledgeBaseOptions {
    repos: Repositories;
    vectors?: KbVectors;
    onError?: (error: unknown, context: { itemId?: string }) => void;
}

/**
 * 入库前的凭据检测(ADR 0015 第 7 节,复用记忆的规则):能定位的凭据替换为占位文字;
 * 替换后仍能检测到凭据的块整块丢弃。原文不进入分块表、FTS 与向量。
 */
export function guardCredentials(chunks: KbChunkInput[]): KbChunkInput[] {
    const out: KbChunkInput[] = [];
    for (const chunk of chunks) {
        const text = redactCredentials(chunk.text).text;
        const heading = chunk.heading ? redactCredentials(chunk.heading).text : chunk.heading;
        if (detectCredential(text) || (heading && detectCredential(heading))) continue;
        out.push({ ...chunk, text, heading });
    }
    return out;
}

/** 交给嵌入的文本:带上文件名与标题,让短片段也有上下文。 */
export function embedText(file: string, chunk: KbChunkInput): string {
    const title = chunk.heading ? `${file} › ${chunk.heading}` : file;
    return `${title}\n\n${chunk.text}`;
}

export function createKnowledgeBase(options: KnowledgeBaseOptions) {
    const { repos, vectors } = options;
    const running = new Map<string, Promise<void>>();
    const again = new Set<string>();

    async function indexOwner(ownerId: string): Promise<void> {
        // 文件被删除或授权被撤销后,items 中的条目是软删除:这里删除它的分块与向量
        for (const itemId of repos.kb.staleItems(ownerId)) {
            repos.kb.remove(itemId);
            repos.embeddings.removeItem(itemId);
        }
        const size = repos.settings.get(ownerId).knowledgeBase.chunkChars;
        const allRoots = repos.fsRoots.list(ownerId);
        const roots = allRoots.map((r) => r.path);
        // 只有勾选了「加入知识库」的目录才入库;取消勾选后清理已有的分块与向量(ADR 0015 第 6 节)
        const kbRoots = allRoots.filter((r) => r.knowledgeBase).map((r) => r.path);
        for (const file of repos.kb.files(ownerId)) {
            const ext = extname(file.path).toLowerCase();
            if (!KB_EXTENSIONS.has(ext)) continue;
            if (!kbRoots.some((root) => isWithin(file.path, root))) {
                if (repos.kb.source(file.itemId)) {
                    repos.kb.remove(file.itemId);
                    repos.embeddings.removeItem(file.itemId);
                }
                continue;
            }
            const source = repos.kb.source(file.itemId);
            if (source && source.mtime === file.mtime && source.size === file.size && source.chunkChars === size) {
                continue;
            }
            let chunks: KbChunkInput[] = [];
            let error: string | null = null;
            try {
                // 与 fs.read 同一套路径校验与解析(ADR 0011):越权或解析失败时只记录错误
                const { text } = await readAuthorizedFile(file.path, roots);
                chunks = guardCredentials(chunkText(text, { size, pdf: ext === '.pdf' }));
            } catch (e) {
                error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
                options.onError?.(e, { itemId: file.itemId });
            }
            repos.kb.replace(ownerId, { ...file, chunkChars: size }, chunks, error);
            repos.embeddings.removeItem(file.itemId, chunks.length);
            const name = basename(file.path);
            for (const [i, chunk] of chunks.entries())
                vectors?.enqueue(ownerId, file.itemId, i, embedText(name, chunk));
        }
    }

    const kb = {
        /** 重新索引(增量:mtime、size 与块大小都没变的文件跳过);同一 owner 同时只运行一次。 */
        index(ownerId: string): Promise<void> {
            const current = running.get(ownerId);
            if (current) {
                again.add(ownerId);
                return current;
            }
            const promise = (async () => {
                do {
                    again.delete(ownerId);
                    await indexOwner(ownerId);
                } while (again.has(ownerId));
            })()
                .catch((error: unknown) => options.onError?.(error, {}))
                .finally(() => running.delete(ownerId));
            running.set(ownerId, promise);
            return promise;
        },

        /**
         * 把不在授权目录中的一段内容(例如邮件附件,ADR 0016)放进知识库:同样分块、检测并替换凭据、排队嵌入。
         * 条目被软删除后,下一次 index() 会清理它的分块与向量。
         */
        indexContent(
            ownerId: string,
            input: { itemId: string; name: string; text: string; size: number; pdf?: boolean },
        ): number {
            const size = repos.settings.get(ownerId).knowledgeBase.chunkChars;
            const chunks = guardCredentials(chunkText(input.text, { size, pdf: input.pdf ?? false }));
            repos.kb.replace(
                ownerId,
                { itemId: input.itemId, mtime: null, size: input.size, chunkChars: size },
                chunks,
            );
            repos.embeddings.removeItem(input.itemId, chunks.length);
            for (const [i, chunk] of chunks.entries()) {
                vectors?.enqueue(ownerId, input.itemId, i, embedText(input.name, chunk));
            }
            return chunks.length;
        },

        /** 等待正在进行的索引结束(测试用)。 */
        async idle(): Promise<void> {
            while (running.size > 0) await Promise.all(running.values());
        },

        async search(
            ownerId: string,
            query: string,
            limit: number,
            signal?: AbortSignal,
        ): Promise<{ mode: 'vector' | 'fts'; chunks: KbChunk[] }> {
            let matches: { itemId: string; chunk: number }[] | null = null;
            try {
                // 向量表里以后也会有记忆等其他条目:多取一些,只留知识库的分块
                matches = (await vectors?.search(ownerId, query, limit * 3, signal)) ?? null;
            } catch (error) {
                options.onError?.(error, {});
            }
            if (matches && matches.length > 0) {
                const chunks = matches
                    .map((m) => repos.kb.get(ownerId, m.itemId, m.chunk))
                    .filter((c): c is KbChunk => c !== null)
                    .slice(0, limit);
                if (chunks.length > 0) return { mode: 'vector', chunks };
            }
            return { mode: 'fts', chunks: repos.kb.search(ownerId, query, limit) };
        },
    };
    return kb;
}

export type KnowledgeBase = ReturnType<typeof createKnowledgeBase>;

const KbSearchInput = z.strictObject({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(10).default(5),
});

/** 把检索到的分块排成带编号引用的文本,交给模型时整体标为不可信(ADR 0010 第 7 节)。 */
export function formatResults(mode: 'vector' | 'fts', chunks: readonly KbChunk[]): KbSearchOutput {
    const citations: KbCitation[] = [];
    const parts: string[] = [];
    let used = 0;
    let truncated = false;
    for (const c of chunks) {
        const n = citations.length + 1;
        const file = c.title;
        const where = [file, c.page ? `p.${c.page}` : null, c.heading].filter(Boolean).join(', ');
        const block = `[${n}] ${where}\n${c.text}`;
        if (used + block.length > MAX_OUTPUT_CHARS) {
            truncated = true;
            break;
        }
        used += block.length;
        parts.push(block);
        citations.push({ n, itemId: c.itemId, file, path: c.path ?? file, page: c.page, heading: c.heading });
    }
    return {
        untrusted: true,
        source: { kind: 'file', ref: 'kb.search' },
        content: parts.length ? parts.join('\n\n') : 'No matching passages in the knowledge base.',
        truncated,
        mode,
        citations,
    };
}

/** kb.search(read):在授权目录的文本与文档中检索,返回带文件名与页码的片段。 */
export function createKbTools(kb: KnowledgeBase, beforeSearch?: (ownerId: string) => Promise<void>): ToolDefinition[] {
    return [
        {
            name: 'kb.search',
            description:
                'Search the text and documents (Markdown, text, PDF, DOCX, XLSX) in the folders the user authorized. ' +
                'Returns numbered passages with file name and PDF page. Cite them as [n] with the file name and page.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to look for, in the language of the documents.' },
                    limit: { type: 'integer', minimum: 1, maximum: 10 },
                },
                required: ['query'],
                additionalProperties: false,
            },
            risk: 'read',
            untrustedOutput: true,
            summarize: (input) => {
                const parsed = KbSearchInput.safeParse(input);
                return parsed.success ? `Search the knowledge base: ${parsed.data.query}` : 'Search the knowledge base';
            },
            execute: async (input, ctx) => {
                const { query, limit } = KbSearchInput.parse(input);
                await beforeSearch?.(ctx.ownerId);
                const { mode, chunks } = await kb.search(ctx.ownerId, query, limit);
                return formatResults(mode, chunks);
            },
        },
    ];
}
