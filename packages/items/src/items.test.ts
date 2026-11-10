// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRepositories, openStorage, type Repositories } from '@ai-personal/storage';
import { PathError, type ToolContext } from '@ai-personal/tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createItemService, createItemTools, decodeText, splitChapters, walk } from './index.js';

let dir: string;
let base: string;
let close: () => void;
let repos: Repositories;
let ownerId: string;

const NOVEL = [
    '序言:这是一个故事。',
    '第一章 开端',
    '很久很久以前。',
    '第二章 发展',
    '后来发生了很多事。',
    '第三章 结局',
    '完。',
].join('\n');

beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'aip-items-db-'));
    const { conn } = await openStorage({ dataDir: dir });
    close = () => conn.close();
    repos = createRepositories(conn);
    ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
    base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'aip-items-fs-')));
    mkdirSync(path.join(base, 'Library', '科幻'), { recursive: true });
    mkdirSync(path.join(base, 'Library', '.hidden'));
    mkdirSync(path.join(base, 'Outside'));
    writeFileSync(path.join(base, 'Library', '科幻', '星海.txt'), NOVEL);
    writeFileSync(path.join(base, 'Library', 'notes.md'), '# 笔记\n普通文本,不是小说。');
    writeFileSync(path.join(base, 'Library', '.hidden', 'x.txt'), 'hidden');
    writeFileSync(path.join(base, 'Outside', 'secret.txt'), 'top secret');
});
afterEach(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
});

const child = (parentId: string, title: string) => {
    const found = repos.items
        .children(ownerId, parentId, { limit: 200, sort: 'position' })
        .items.find((i) => i.title === title);
    if (!found) throw new Error(`no child "${title}"`);
    return found;
};
const root = (title: string) => {
    const found = repos.items.roots(ownerId).find((r) => r.title === title);
    if (!found) throw new Error(`no root "${title}"`);
    return found;
};

describe('章节切分与编码', () => {
    it('按「第…章」与 Chapter 切分,标题前的内容记为「序」;不足 2 个标题时不是小说', () => {
        expect(splitChapters(NOVEL)?.map((c) => c.title)).toEqual(['序', '第一章 开端', '第二章 发展', '第三章 结局']);
        expect(splitChapters('Chapter 1 Start\nA\nChapter 2 End\nB')?.map((c) => c.title)).toEqual([
            'Chapter 1 Start',
            'Chapter 2 End',
        ]);
        expect(splitChapters('第一章 只有一章\n内容')).toBeNull();
        expect(splitChapters('普通的文字')).toBeNull();
    });

    it('UTF-8(含 BOM)直接解码;无效 UTF-8 改用 GB18030', () => {
        expect(decodeText(Buffer.from('\uFEFF你好', 'utf8'))).toBe('你好');
        // 「第一章」的 GB18030 编码
        expect(decodeText(Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]))).toBe('第一章');
    });

    it('遍历不跟随链接、跳过隐藏项,并有数量与深度上限', () => {
        symlinkSync(
            path.join(base, 'Outside'),
            path.join(base, 'Library', 'link'),
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        const all = walk(path.join(base, 'Library'));
        expect(all.entries.map((e) => e.name).sort()).toEqual(['notes.md', '星海.txt', '科幻']);
        expect(walk(path.join(base, 'Library'), { entries: 1, depth: 8 })).toMatchObject({ truncated: true });
        expect(walk(path.join(base, 'Library'), { entries: 100, depth: 1 })).toMatchObject({ truncated: true });
    });
});

describe('提供者与同步', () => {
    it('验收:授权含小说的文件夹后,「小说 → 书 → 章」逐层下钻并打开;文件与会话也可浏览;计数一致', async () => {
        const service = createItemService({ repos });
        const fsRoot = repos.fsRoots.create(ownerId, { path: path.join(base, 'Library'), label: '书库' });
        const session = repos.sessions.create(ownerId, { title: '旅行计划' });
        repos.messages.append(ownerId, session.id, {
            role: 'user',
            parts: [{ type: 'text', text: '去杭州' }],
            status: 'complete',
        });
        await service.sync(ownerId);

        expect(
            repos.items
                .roots(ownerId)
                .map((r) => r.title)
                .sort(),
        ).toEqual(['会话', '小说', '文件']);
        const novels = root('小说');
        const book = child(novels.id, '星海');
        expect(book).toMatchObject({ type: 'novel', childCount: 4, summary: '4 chapters' });
        const chapter = child(book.id, '第二章 发展');
        expect(repos.items.ancestors(ownerId, chapter.id).map((a) => a.title)).toEqual(['小说', '星海']);
        expect(await service.open(ownerId, chapter)).toEqual({
            format: 'text',
            content: '第二章 发展\n后来发生了很多事。\n',
            truncated: false,
        });

        const files = root('文件');
        const library = child(files.id, '书库');
        expect(library).toMatchObject({ type: 'files.root', childCount: 2, descendantCount: 3 });
        const notes = child(library.id, 'notes.md');
        expect((await service.open(ownerId, notes)).content).toContain('普通文本');
        expect(repos.items.counts(ownerId, files.id)).toEqual({
            children: 1,
            descendants: 4,
            byType: { 'files.root': 1, 'files.folder': 1, 'files.file': 2 },
        });

        const sessions = root('会话');
        expect((await service.open(ownerId, child(sessions.id, '旅行计划'))).content).toBe('user: 去杭州');
        expect(repos.items.recount(ownerId)).toBe(0);

        // 再次同步:没有变化时结果相同;删除文件后对应条目软删除
        rmSync(path.join(base, 'Library', 'notes.md'));
        await service.sync(ownerId);
        expect(repos.items.get(ownerId, notes.id)?.deletedAt).not.toBeNull();
        expect(repos.items.get(ownerId, library.id)).toMatchObject({ childCount: 1, descendantCount: 2 });
        expect(repos.items.recount(ownerId)).toBe(0);

        // 撤销授权目录:文件与小说的子树软删除;已有的章节条目也不能再打开
        repos.fsRoots.delete(ownerId, fsRoot.id);
        await expect(service.open(ownerId, chapter)).rejects.toThrow(PathError);
        await service.sync(ownerId);
        expect(repos.items.get(ownerId, library.id)?.deletedAt).not.toBeNull();
        expect(repos.items.get(ownerId, book.id)?.deletedAt).not.toBeNull();
        expect(root('文件')).toMatchObject({ childCount: 0, descendantCount: 0 });
        expect(root('小说')).toMatchObject({ childCount: 0, descendantCount: 0 });
        expect(repos.items.recount(ownerId)).toBe(0);
    });

    it('打开文件条目前重新校验路径:被替换成指向外面的条目被拒绝', async () => {
        const service = createItemService({ repos });
        repos.fsRoots.create(ownerId, { path: path.join(base, 'Library'), label: '书库' });
        await service.sync(ownerId);
        const notes = child(child(root('文件').id, '书库').id, 'notes.md');
        const forged = { ...notes, sourceRef: `x:${path.join(base, 'Outside', 'secret.txt')}` };
        await expect(service.open(ownerId, forged)).rejects.toThrow(/outside the authorized folders/);
    });

    it('一个提供者失败不影响其他提供者;同一 owner 的同步合并为一次;过期才重新同步', async () => {
        const errors: string[] = [];
        let calls = 0;
        let clock = 0;
        const service = createItemService({
            repos,
            now: () => clock,
            providers: [
                {
                    id: 'broken',
                    sync: () => Promise.reject(new Error('boom')),
                    open: () => Promise.reject(new Error('x')),
                },
                {
                    id: 'counter',
                    sync: async () => {
                        calls++;
                        await new Promise((r) => setTimeout(r, 5));
                    },
                    open: () => Promise.resolve({ format: 'text', content: '', truncated: false }),
                },
            ],
            onError: (_e, { provider }) => errors.push(provider),
        });
        await Promise.all([service.sync(ownerId), service.sync(ownerId)]);
        expect(calls).toBe(1);
        expect(errors).toEqual(['broken']);
        await service.syncIfStale(ownerId);
        expect(calls).toBe(1);
        clock = 61_000;
        await service.syncIfStale(ownerId);
        expect(calls).toBe(2);
        const orphan = repos.items.upsert(ownerId, {
            source: 'nobody',
            sourceRef: 'x',
            kind: 'content',
            type: 'x',
            title: 'x',
            parentId: null,
        });
        await expect(service.open(ownerId, orphan)).rejects.toThrow(/no provider/);
    });
});

describe('items.* 工具', () => {
    it('roots / children / get / search / open;open 的输出标为不可信;不存在或记忆条目报错', async () => {
        const service = createItemService({ repos });
        repos.fsRoots.create(ownerId, { path: path.join(base, 'Library'), label: '书库' });
        const tools = Object.fromEntries(createItemTools(repos, service).map((t) => [t.name, t]));
        const ctx: ToolContext = {
            ownerId,
            sessionId: 's',
            runId: 'r',
            userMessageId: 'u',
            assistantMessageId: 'a',
            untrustedContentSeen: false,
        };
        const roots = (await tools['items.roots']!.execute({}, ctx)) as { items: { id: string; title: string }[] };
        const novels = roots.items.find((r) => r.title === '小说')!;
        const books = (await tools['items.children']!.execute({ id: novels.id }, ctx)) as { items: { id: string }[] };
        const chapters = (await tools['items.children']!.execute({ id: books.items[0]!.id }, ctx)) as {
            items: { id: string; title: string }[];
        };
        const first = chapters.items.find((c) => c.title === '第一章 开端')!;
        expect(await tools['items.get']!.execute({ id: first.id }, ctx)).toMatchObject({ path: ['小说', '星海'] });
        expect(await tools['items.open']!.execute({ id: first.id }, ctx)).toEqual({
            untrusted: true,
            source: { kind: 'item', ref: first.id },
            content: '第一章 开端\n很久很久以前。\n',
            truncated: false,
        });
        const found = (await tools['items.search']!.execute({ query: '第三章', under: novels.id }, ctx)) as {
            items: { title: string }[];
        };
        expect(found.items.map((i) => i.title)).toEqual(['第三章 结局']);
        await expect(tools['items.get']!.execute({ id: 'missing' }, ctx)).rejects.toThrow(/no such item/);
        const memory = repos.items.upsert(ownerId, {
            source: 'memory',
            sourceRef: 'm1',
            kind: 'content',
            type: 'memory.semantic',
            title: '用户住在杭州',
            parentId: null,
        });
        await expect(tools['items.open']!.execute({ id: memory.id }, ctx)).rejects.toThrow(/no such item/);
        expect(tools['items.open']!.untrustedOutput).toBe(true);
        expect(Object.values(tools).every((t) => t.risk === 'read')).toBe(true);
    });
});
