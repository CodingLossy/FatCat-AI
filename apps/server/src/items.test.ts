// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 条目索引 REST(ADR 0012):小说逐层下钻并打开;撤销授权目录后打开被拒绝并写审计。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuditEntry, FsRoot, Item, ItemContent, ItemCounts, ItemSubtree, pageOf } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
let base: string;
beforeEach(() => {
    base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fatcat-items-api-')));
    mkdirSync(path.join(base, 'Books'));
    writeFileSync(
        path.join(base, 'Books', '凡人.txt'),
        ['第一章 山村少年', '他出生在一个小山村。', '第二章 入门', '他拜入了七玄门。'].join('\n'),
    );
});
afterEach(async () => {
    await s?.cleanup();
    rmSync(base, { recursive: true, force: true });
});

async function setup() {
    s = await createTestServer();
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const req = (p: string, init: RequestInit = {}) => s.app.request(p, { ...init, headers });
    const post = (p: string, body: unknown = {}) => req(p, { method: 'POST', body: JSON.stringify(body) });
    const items = async (p: string) => pageOf(Item).parse(await (await req(p)).json()).items;
    return { req, post, items };
}

describe('/api/v1/items', () => {
    it('验收:授权含小说的文件夹后,「小说 → 某书 → 某章」逐层下钻并打开;计数与子树正确', async () => {
        const { req, post, items } = await setup();
        await post('/api/v1/fs/roots', { path: path.join(base, 'Books'), label: '书架' });
        expect((await post('/api/v1/items/sync')).status).toBe(204);

        const roots = await items('/api/v1/items/roots');
        expect(roots.map((r) => r.title).sort()).toEqual(['会话', '小说', '文件']);
        const novels = roots.find((r) => r.title === '小说')!;
        const [book] = await items(`/api/v1/items/${novels.id}/children`);
        expect(book).toMatchObject({ title: '凡人', type: 'novel', childCount: 2 });
        const chapters = await items(`/api/v1/items/${book!.id}/children?sort=position`);
        expect(chapters.map((c) => c.title)).toEqual(['第一章 山村少年', '第二章 入门']);

        const content = ItemContent.parse(await (await req(`/api/v1/items/${chapters[1]!.id}/content`)).json());
        expect(content).toEqual({ format: 'text', content: '第二章 入门\n他拜入了七玄门。', truncated: false });
        expect((await items(`/api/v1/items/${chapters[1]!.id}/ancestors`)).map((a) => a.title)).toEqual([
            '小说',
            '凡人',
        ]);
        expect(ItemCounts.parse(await (await req(`/api/v1/items/${novels.id}/counts`)).json())).toEqual({
            children: 1,
            descendants: 3,
            byType: { novel: 1, 'novel.chapter': 2 },
        });
        const subtree = ItemSubtree.parse(await (await req(`/api/v1/items/${novels.id}/subtree?depth=2`)).json());
        expect(subtree.nodes.map((n) => [n.item.title, n.depth])).toEqual([
            ['凡人', 1],
            ['第一章 山村少年', 2],
            ['第二章 入门', 2],
        ]);
        expect((await items(`/api/v1/items/search?q=${encodeURIComponent('入门')}`)).map((i) => i.title)).toEqual([
            '第二章 入门',
        ]);
        expect((await req('/api/v1/items/search?q=')).status).toBe(400);
        expect((await req('/api/v1/items/01JC0000000000000000000000')).status).toBe(404);
        expect((await req(`/api/v1/items/${novels.id}/subtree?depth=9`)).status).toBe(400);
    });

    it('撤销授权目录后:条目软删除(只在 changes 中出现);已知 id 的打开被拒绝(403)并写审计', async () => {
        const { req, post, items } = await setup();
        const root = FsRoot.parse(await (await post('/api/v1/fs/roots', { path: path.join(base, 'Books') })).json());
        await post('/api/v1/items/sync');
        const novels = (await items('/api/v1/items/roots')).find((r) => r.title === '小说')!;
        const [book] = await items(`/api/v1/items/${novels.id}/children`);
        const [chapter] = await items(`/api/v1/items/${book!.id}/children`);

        // 撤销后、同步完成前,打开就已经被拒绝(路径在打开时重新校验)
        expect((await req(`/api/v1/fs/roots/${root.id}`, { method: 'DELETE' })).status).toBe(204);
        const denied = await req(`/api/v1/items/${chapter!.id}/content`);
        expect([403, 404]).toContain(denied.status);

        await post('/api/v1/items/sync');
        expect((await req(`/api/v1/items/${chapter!.id}`)).status).toBe(404);
        expect((await items('/api/v1/items/roots')).find((r) => r.title === '小说')).toMatchObject({
            childCount: 0,
            descendantCount: 0,
        });
        const changes = await items('/api/v1/items/changes?limit=200');
        expect(changes.find((i) => i.id === chapter!.id)?.deletedAt).not.toBeNull();

        if (denied.status === 403) {
            const audit = pageOf(AuditEntry).parse(await (await req('/api/v1/audit')).json()).items;
            expect(audit[0]).toMatchObject({ toolName: 'items.content', decision: 'denied', outcome: 'not_run' });
        }
    });

    it('打开授权目录外的文件(授权目录被换掉之后):403 并审计 denied', async () => {
        const { req, post, items } = await setup();
        mkdirSync(path.join(base, 'Other'));
        const books = FsRoot.parse(await (await post('/api/v1/fs/roots', { path: path.join(base, 'Books') })).json());
        await post('/api/v1/fs/roots', { path: path.join(base, 'Other') });
        await post('/api/v1/items/sync');
        const files = (await items('/api/v1/items/roots')).find((r) => r.title === '文件')!;
        const shelf = (await items(`/api/v1/items/${files.id}/children`)).find(
            (i) => i.summary === path.join(base, 'Books'),
        )!;
        const [file] = await items(`/api/v1/items/${shelf.id}/children`);
        // 撤销 Books 后不再同步:条目还在,但打开时路径已不在任何授权目录内
        const me = (await (await req('/api/v1/auth/me')).json()) as { id: string };
        s.repos.fsRoots.delete(me.id, books.id);
        const denied = await req(`/api/v1/items/${file!.id}/content`);
        expect(denied.status).toBe(403);
        const audit = pageOf(AuditEntry).parse(await (await req('/api/v1/audit')).json()).items;
        expect(audit[0]).toMatchObject({ toolName: 'items.content', decision: 'denied', outcome: 'not_run' });
    });
});
