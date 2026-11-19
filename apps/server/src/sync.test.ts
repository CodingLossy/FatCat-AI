// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// ADR 0045 第 2 节:GET /api/v1/sync 增量同步。
import { SyncResponse } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(() => s?.cleanup());

async function boot() {
    s = await createTestServer();
    const session = sessionFrom(
        await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD })),
    );
    const owner = s.repos.owners.ids()[0]!;
    const sync = async (query = '', headers: Record<string, string> = { cookie: session.cookie }) => {
        const res = await s.app.request(`/api/v1/sync${query}`, { headers });
        return { status: res.status, body: res.status === 200 ? SyncResponse.parse(await res.json()) : null };
    };
    return { session, owner, sync };
}

describe('GET /sync', () => {
    it('没有游标给完整快照;之后只给变化;删除以墓碑表示;kinds 与 limit 生效', async () => {
        const { owner, sync } = await boot();
        const a = s.repos.sessions.create(owner, { title: 'a' });
        const b = s.repos.sessions.create(owner, { title: 'b' });
        const m = s.repos.messages.append(owner, a.id, {
            role: 'user',
            parts: [{ type: 'text', text: 'hi' }],
            status: 'complete',
        });

        const full = (await sync()).body!;
        expect(full.hasMore).toBe(false);
        expect(
            full.changes
                .filter((c) => c.kind === 'session')
                .map((c) => c.id)
                .sort(),
        ).toEqual([a.id, b.id].sort());
        expect(full.changes.find((c) => c.kind === 'message')).toMatchObject({ id: m.id, deleted: false });

        // 没有新变化:空批次,游标原样返回
        const none = (await sync(`?cursor=${full.cursor}`)).body!;
        expect(none).toMatchObject({ changes: [], cursor: full.cursor, hasMore: false });

        // 改标题、删另一个会话:只有这两个变化
        s.repos.sessions.update(owner, a.id, { title: 'a2' });
        s.repos.sessions.delete(owner, b.id);
        const inc = (await sync(`?cursor=${full.cursor}`)).body!;
        expect(inc.changes.map((c) => [c.kind, c.id, c.deleted])).toEqual([
            ['session', a.id, false],
            ['session', b.id, true],
        ]);
        expect(inc.changes[0]).toMatchObject({ session: { title: 'a2' } });

        // 删除会话级联的消息墓碑带 sessionId
        s.repos.sessions.delete(owner, a.id);
        const gone = (await sync(`?cursor=${inc.cursor}`)).body!;
        expect(gone.changes.find((c) => c.kind === 'message')).toMatchObject({
            id: m.id,
            deleted: true,
            sessionId: a.id,
        });

        // kinds 过滤与分页
        const onlyMessages = (await sync('?kinds=message')).body!;
        expect(onlyMessages.changes.every((c) => c.kind === 'message')).toBe(true);
        const page = (await sync('?limit=1')).body!;
        expect(page.changes).toHaveLength(1);
        expect(page.hasMore).toBe(true);
        const rest = (await sync(`?limit=500&cursor=${page.cursor}`)).body!;
        expect(rest.changes.length).toBeGreaterThan(0);
    });

    it('未登录 401、参数非法 400;已配对设备令牌可以读', async () => {
        const { session, sync } = await boot();
        expect((await sync('', {})).status).toBe(401);
        expect((await sync('?cursor=abc')).status).toBe(400);
        expect((await sync('?kinds=session,bogus')).status).toBe(400);

        const code = (await (
            await s.app.request('/api/v1/devices/pairing-codes', {
                method: 'POST',
                headers: { cookie: session.cookie, 'X-CSRF-Token': session.csrf },
            })
        ).json()) as { code: string };
        const tokens = (await (
            await s.app.request('/api/v1/devices/pair', jsonBody({ code: code.code, name: 'p' }))
        ).json()) as { accessToken: string };
        expect((await sync('', { authorization: `Bearer ${tokens.accessToken}` })).status).toBe(200);
    });
});
