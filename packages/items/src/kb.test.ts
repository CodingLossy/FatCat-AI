// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRepositories, openStorage } from '@fatcat-ai/storage';
import type { ToolContext } from '@fatcat-ai/tools';
import { describe, expect, it } from 'vitest';
import { createItemService } from './service.js';
import {
    chunkText,
    createKbTools,
    createKnowledgeBase,
    embedText,
    formatResults,
    guardCredentials,
    type KbVectors,
    MAX_CHUNKS_PER_FILE,
} from './kb/index.js';

describe('知识库分块', () => {
    it('按段落合并到块大小;换标题时另起一块并记下标题', () => {
        const text = '# 简介\n第一段。\n\n第二段。\n\n## 退款\n退款需要在 30 天内申请。\n';
        expect(chunkText(text, { size: 1000 })).toEqual([
            { page: null, heading: '简介', text: '第一段。\n\n第二段。' },
            { page: null, heading: '退款', text: '退款需要在 30 天内申请。' },
        ]);
    });

    it('PDF 按分页行记页码,跨页另起一块;普通文本中的同样行不算页码', () => {
        const pdf = '--- page 1 ---\nIntro text\n\n--- page 2 ---\nRefund policy\n\n--- page 3 ---\nOffice hours';
        expect(chunkText(pdf, { size: 1000, pdf: true }).map((c) => [c.page, c.text])).toEqual([
            [1, 'Intro text'],
            [2, 'Refund policy'],
            [3, 'Office hours'],
        ]);
        expect(chunkText('--- page 9 ---\nhello', { size: 1000 })).toEqual([
            { page: null, heading: null, text: '--- page 9 ---\nhello' },
        ]);
    });

    it('超过块大小的段落按句子切开,单句过长时按字符切开;块数有上限', () => {
        const long = '这是一句话。'.repeat(50); // 300 字
        const chunks = chunkText(long, { size: 100 });
        expect(chunks.length).toBeGreaterThanOrEqual(3);
        expect(chunks.every((c) => c.text.length <= 100)).toBe(true);
        expect(chunks.map((c) => c.text).join('')).toBe(long);
        expect(chunkText('x'.repeat(250), { size: 100 }).map((c) => c.text.length)).toEqual([100, 100, 50]);
        expect(chunkText('段落。\n\n'.repeat(MAX_CHUNKS_PER_FILE + 10), { size: 3 })).toHaveLength(MAX_CHUNKS_PER_FILE);
    });

    it('嵌入文本带文件名与标题;检索结果带编号引用,整体标为不可信', () => {
        expect(embedText('a.md', { page: null, heading: '退款', text: 't' })).toBe('a.md › 退款\n\nt');
        const out = formatResults('fts', [
            {
                itemId: '01JC0000000000000000000000',
                chunk: 0,
                page: 2,
                heading: null,
                text: 'Refund policy',
                title: 'handbook.pdf',
                path: '/docs/handbook.pdf',
            },
        ]);
        expect(out).toMatchObject({
            untrusted: true,
            mode: 'fts',
            content: '[1] handbook.pdf, p.2\nRefund policy',
            citations: [{ n: 1, file: 'handbook.pdf', page: 2, path: '/docs/handbook.pdf' }],
        });
        expect(formatResults('vector', []).content).toMatch(/No matching/);
    });
});

describe('知识库索引与检索', () => {
    it('增量索引、入队嵌入、向量优先与全文兜底、文件删除后清理;索引失败只记错误', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'fatcat-kb-db-'));
        const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fatcat-kb-fs-')));
        const { conn } = await openStorage({ dataDir: dir });
        try {
            const repos = createRepositories(conn);
            const ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
            writeFileSync(path.join(base, 'a.md'), '# 退款\n退款需要在三十天内申请。');
            writeFileSync(path.join(base, 'b.txt'), 'Office hours are 9 to 6.');
            writeFileSync(path.join(base, 'broken.pdf'), 'not a pdf');
            writeFileSync(path.join(base, 'skip.json'), '{}');
            repos.fsRoots.create(ownerId, { path: base, label: 'docs', knowledgeBase: true });

            const queued: string[] = [];
            let vectorResult: { itemId: string; chunk: number }[] | null = null;
            const vectors: KbVectors = {
                enqueue: (_o, _i, _c, text) => void queued.push(text),
                search: () => Promise.resolve(vectorResult),
            };
            const errors: unknown[] = [];
            const kb = createKnowledgeBase({ repos, vectors, onError: (e) => errors.push(e) });
            const items = createItemService({ repos, onSynced: (o) => void kb.index(o) });
            await items.sync(ownerId);
            await kb.idle();

            expect(repos.kb.counts(ownerId)).toEqual({ files: 3, chunks: 2 });
            expect(queued.sort()).toEqual([
                'a.md › 退款\n\n退款需要在三十天内申请。',
                'b.txt\n\nOffice hours are 9 to 6.',
            ]);
            expect(errors).toHaveLength(1); // broken.pdf

            const ctx = { ownerId } as ToolContext;
            const [tool] = createKbTools(kb, () => Promise.resolve());
            expect(tool!.summarize({ query: '退款' })).toBe('Search the knowledge base: 退款');
            const fts = (await tool!.execute({ query: 'Office hours' }, ctx)) as { mode: string; citations: unknown[] };
            expect(fts).toMatchObject({ mode: 'fts', citations: [{ file: 'b.txt' }] });
            // 少于 3 个字符走 LIKE
            expect((await kb.search(ownerId, '退款', 5)).chunks.map((c) => c.title)).toEqual(['a.md']);

            const aId = repos.kb.files(ownerId).find((f) => f.path.endsWith('a.md'))!.itemId;
            vectorResult = [
                { itemId: 'not-a-kb-item', chunk: 0 },
                { itemId: aId, chunk: 0 },
            ];
            expect(await kb.search(ownerId, 'refund', 5)).toMatchObject({
                mode: 'vector',
                chunks: [{ title: 'a.md' }],
            });

            // 文件未变:不重新入队;删除文件:分块清理
            queued.length = 0;
            await items.sync(ownerId);
            await kb.idle();
            expect(queued).toEqual([]);
            unlinkSync(path.join(base, 'a.md'));
            await items.sync(ownerId);
            await kb.idle();
            expect(repos.kb.counts(ownerId)).toEqual({ files: 2, chunks: 1 });
            expect(repos.kb.get(ownerId, aId, 0)).toBeNull();
        } finally {
            conn.close();
            rmSync(dir, { recursive: true, force: true });
            rmSync(base, { recursive: true, force: true });
        }
    });

    it('只有勾选「加入知识库」的目录入库;取消勾选后清理;凭据入库前替换或整块拦截', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'fatcat-kb-db-'));
        const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fatcat-kb-fs-')));
        const { conn } = await openStorage({ dataDir: dir });
        try {
            const repos = createRepositories(conn);
            const ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
            const pub = path.join(base, 'notes');
            const priv = path.join(base, 'private');
            mkdirSync(pub);
            mkdirSync(priv);
            const key = ['sk', '-proj-', 'a1B2c3D4e5F6g7H8i9J0kLmN'].join('');
            writeFileSync(path.join(pub, 'deploy.md'), `# 部署\n部署时设置 OPENAI_API_KEY=${key} 后重启服务。`);
            writeFileSync(path.join(pub, 'safe.md'), '# 周报\n本周完成了记忆检索。');
            writeFileSync(path.join(priv, 'diary.md'), '# 日记\n今天去爬山。');
            const notes = repos.fsRoots.create(ownerId, { path: pub, label: 'notes', knowledgeBase: true });
            repos.fsRoots.create(ownerId, { path: priv, label: 'private' });

            const kb = createKnowledgeBase({ repos });
            const items = createItemService({ repos, onSynced: (o) => void kb.index(o) });
            await items.sync(ownerId);
            await kb.idle();
            // 未勾选的目录不入库
            expect((await kb.search(ownerId, '爬山', 5)).chunks).toEqual([]);
            const deploy = (await kb.search(ownerId, '重启服务', 5)).chunks;
            expect(deploy).toHaveLength(1);
            expect(deploy[0]!.text).toContain('[已隐藏凭据]');
            expect(JSON.stringify(deploy)).not.toContain(key);
            expect(guardCredentials([{ text: 'wifi 密码是 hunter22。记得改', heading: null, page: null }])).toEqual([
                { text: 'wifi [已隐藏凭据]。记得改', heading: null, page: null },
            ]);

            repos.fsRoots.setKnowledgeBase(ownerId, notes.id, false);
            items.invalidate(ownerId);
            await items.sync(ownerId);
            await kb.idle();
            expect(repos.kb.counts(ownerId)).toEqual({ files: 0, chunks: 0 });
        } finally {
            conn.close();
            rmSync(dir, { recursive: true, force: true });
            rmSync(base, { recursive: true, force: true });
        }
    });
});
