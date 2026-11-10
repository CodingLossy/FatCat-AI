// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// novels 提供者:「小说」→ 书 → 章(ADR 0012 第 3 节)。授权目录中的 .txt 文件,至少有 2 行章节标题时识别为小说。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Item, ItemContent } from '@ai-personal/shared';
import { resolveInRoots } from '@ai-personal/tools';
import { type ItemProvider, type OpenContext, type SyncContext, textContent } from './provider.js';
import { walk } from './walk.js';

export const NOVELS_ROOT_REF = 'novels';
export const MAX_NOVEL_BYTES = 20 * 1024 * 1024;

/** 章节标题:第…章 / 回 / 节 / 卷、Chapter N。 */
const HEADING =
    /^[ \t\u3000]*((第[0-9０-９零〇一二三四五六七八九十百千万两]+[章回节卷])[^\n]{0,60}|(Chapter|CHAPTER)[ \t]+[0-9IVXLC]+\b[^\n]{0,60})[ \t]*$/gm;

/** 先按 UTF-8 解码;出现无效字节时改用 GB18030(中文小说常见)。 */
export function decodeText(buffer: Buffer): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
    } catch {
        return new TextDecoder('gb18030').decode(buffer);
    }
}

export interface Chapter {
    title: string;
    start: number;
    end: number;
}

/** 按标题行切分;标题前有正文时记为「序」。不足 2 个标题时返回 null(不是小说)。 */
export function splitChapters(text: string): Chapter[] | null {
    const heads = [...text.matchAll(HEADING)].map((m) => ({ title: m[1]!.trim().slice(0, 80), start: m.index }));
    if (heads.length < 2) return null;
    const chapters: Chapter[] = [];
    if (text.slice(0, heads[0]!.start).trim().length > 0)
        chapters.push({ title: '序', start: 0, end: heads[0]!.start });
    heads.forEach((h, i) => chapters.push({ title: h.title, start: h.start, end: heads[i + 1]?.start ?? text.length }));
    return chapters;
}

function bookPath(item: Item): string | null {
    const meta = item.meta as { path?: unknown } | null;
    return typeof meta?.path === 'string' ? meta.path : null;
}

export const novelsProvider: ItemProvider = {
    id: 'novels',
    async sync(ctx: SyncContext) {
        const top = ctx.upsert({
            sourceRef: NOVELS_ROOT_REF,
            kind: 'category',
            type: 'novels',
            title: '小说',
            icon: 'book',
            parentId: null,
        });
        const keepBooks = new Set<string>();
        for (const root of ctx.roots) {
            for (const e of walk(root.path).entries) {
                if (e.type !== 'file' || !/\.txt$/i.test(e.name) || e.size > MAX_NOVEL_BYTES || e.size === 0) continue;
                const ref = `${root.id}:${e.path}`;
                const mtime = new Date(e.mtimeMs).toISOString();
                const existing = ctx.repos.items.bySource(ctx.ownerId, 'novels', ref);
                const meta = existing?.meta as { size?: number; mtime?: string } | null | undefined;
                // 文件没有变化:保留原有章节,不重新读取
                if (existing && !existing.deletedAt && meta?.size === e.size && meta.mtime === mtime) {
                    keepBooks.add(ref);
                    continue;
                }
                let chapters: Chapter[] | null;
                try {
                    chapters = splitChapters(decodeText(readFileSync(e.path)));
                } catch {
                    continue;
                }
                if (!chapters) continue;
                keepBooks.add(ref);
                const book = ctx.upsert({
                    sourceRef: ref,
                    kind: 'category',
                    type: 'novel',
                    title: path.basename(e.name, path.extname(e.name)),
                    summary: `${chapters.length} chapters`,
                    meta: { path: e.path, size: e.size, mtime },
                    parentId: top.id,
                });
                const keepChapters = new Set<string>();
                chapters.forEach((c, i) => {
                    const chapterRef = `${ref}#${i}`;
                    keepChapters.add(chapterRef);
                    ctx.upsert({
                        sourceRef: chapterRef,
                        kind: 'content',
                        type: 'novel.chapter',
                        title: c.title,
                        meta: { start: c.start, end: c.end },
                        parentId: book.id,
                        position: i,
                    });
                });
                ctx.removeMissing(book.id, keepChapters);
            }
        }
        ctx.removeMissing(top.id, keepBooks);
    },
    async open(item: Item, ctx: OpenContext): Promise<ItemContent> {
        if (item.type === 'novel') return textContent(`${item.title}\n${item.summary ?? ''}`);
        if (item.type !== 'novel.chapter') return textContent(item.title);
        const parentId = ctx.repos.items.parentId(item.id);
        const book = parentId ? ctx.repos.items.get(ctx.ownerId, parentId) : null;
        const file = book ? bookPath(book) : null;
        if (!file) throw new Error('the book of this chapter is missing');
        // 打开前重新校验路径:授权目录被撤销后不能再读
        const { path: real } = resolveInRoots(file, ctx.roots);
        const text = decodeText(readFileSync(real));
        const { start, end } = item.meta as { start: number; end: number };
        return textContent(text.slice(start, end));
    },
};
