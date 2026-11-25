// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 两个账户的事件与检索隔离(ADR 0053 第 12 节第 5 项):同时对话时,事件总线、运行事件、增量同步只给本人;
// 记忆检索、条目检索、会话列表搜不到别人的内容;并发上限按账户算,一个账户占满不挡另一个账户。
import type { ChatChunk, ModelProvider } from '@fatcat-ai/providers';
import { type EventEnvelope, LoginResponse, Session, SyncResponse } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

/** 回答里带上用户说的话,方便看出事件属于谁;gate 关着时停在第一段文字之后。 */
function echoProvider(gate: { opened: Promise<void> }): ModelProvider {
    return {
        profileId: 'fake',
        stream: async function* (request): AsyncGenerator<ChatChunk> {
            const last = request.messages.at(-1);
            const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
            yield { type: 'text-delta', delta: `echo ${text.includes('秘密甲') ? '甲' : '乙'}` };
            await gate.opened;
            yield { type: 'finish', reason: 'stop', usage: { outputTokens: 1 } };
        },
        test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
    };
}

type Who = { cookie: string; csrf: string };
const call = (who: Who, method: string, path: string, body?: unknown) =>
    s.app.request(path, {
        method,
        headers: { cookie: who.cookie, 'X-CSRF-Token': who.csrf, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

async function twoAccounts() {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    s = await createTestServer({}, { provider: echoProvider({ opened }), env: {} });
    const admin: Who = sessionFrom(
        await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD })),
    );
    const { code } = (await (await call(admin, 'POST', '/api/v1/admin/users/invites')).json()) as { code: string };
    const res = await s.app.request(
        '/api/v1/auth/invite/accept',
        jsonBody({ code, username: 'kid', password: TEST_PASSWORD }),
    );
    const member: Who = sessionFrom(res);
    const memberId = LoginResponse.parse(await res.json()).owner.id;
    const adminId = s.repos.owners.primaryAdmin()!;
    for (const who of [admin, member]) {
        const created = await call(who, 'POST', '/api/v1/models', {
            label: 'fake',
            kind: 'openai-compatible',
            baseURL: 'http://fake.test/v1',
            apiKeyRef: null,
            model: 'm',
            purpose: ['chat'],
        });
        expect(created.status).toBe(201);
    }
    return { admin, member, adminId, memberId, open };
}

describe('两个账户的隔离', () => {
    it('同时对话:事件总线、运行事件和增量同步只给本人,别人的运行回 404', async () => {
        const { admin, member, adminId, memberId, open } = await twoAccounts();
        const seen = new Map<string, EventEnvelope[]>([
            [adminId, []],
            [memberId, []],
        ]);
        for (const [ownerId, list] of seen) s.bus.subscribe(ownerId, (e) => list.push(e));

        const start = async (who: Who, text: string) => {
            const session = Session.parse(await (await call(who, 'POST', '/api/v1/sessions', {})).json());
            const sent = await call(who, 'POST', `/api/v1/sessions/${session.id}/messages?stream=false`, { text });
            expect(sent.status).toBe(202);
            const { runId } = (await sent.json()) as { runId: string };
            return { session, runId };
        };
        const { session: adminSession, runId } = await start(admin, '秘密甲');
        const { session: memberSession } = await start(member, '秘密乙');
        open();
        await s.runs.idle();

        const texts = (list: EventEnvelope[]) => JSON.stringify(list);
        expect(texts(seen.get(adminId)!)).toContain('echo 甲');
        expect(texts(seen.get(adminId)!)).not.toContain('echo 乙');
        expect(texts(seen.get(memberId)!)).toContain('echo 乙');
        expect(texts(seen.get(memberId)!)).not.toContain('echo 甲');

        expect((await call(admin, 'GET', `/api/v1/runs/${runId}`)).status).toBe(200);
        expect((await call(member, 'GET', `/api/v1/runs/${runId}/events`)).status).toBe(404);
        expect((await call(member, 'GET', `/api/v1/runs/${runId}`)).status).toBe(404);
        expect((await call(member, 'GET', `/api/v1/sessions/${adminSession.id}/messages`)).status).toBe(404);

        const sync = SyncResponse.parse(await (await call(member, 'GET', '/api/v1/sync')).json());
        const ids = sync.changes.map((c) => c.id);
        expect(ids).toContain(memberSession.id);
        expect(ids).not.toContain(adminSession.id);
        expect(JSON.stringify(sync)).not.toContain('秘密甲');
    });

    it('检索:记忆、条目和会话列表搜不到别人的内容', async () => {
        const { admin, member, memberId } = await twoAccounts();
        expect((await call(admin, 'POST', '/api/v1/memory', { text: '管理员常住杭州' })).status).toBe(200);
        expect((await call(member, 'POST', '/api/v1/memory', { text: '成员常住苏州' })).status).toBe(200);

        const search = async (who: Who) =>
            JSON.stringify(await (await call(who, 'POST', '/api/v1/memory/search', { query: '常住' })).json());
        expect(await search(member)).toContain('苏州');
        expect(await search(member)).not.toContain('杭州');
        expect(await search(admin)).not.toContain('苏州');

        const items = async (who: Who, q: string) =>
            JSON.stringify(await (await call(who, 'GET', `/api/v1/items/search?q=${encodeURIComponent(q)}`)).json());
        expect(await items(member, '杭州')).not.toContain('杭州');
        expect(await items(admin, '苏州')).not.toContain('苏州');

        await call(admin, 'POST', '/api/v1/sessions', { title: '管理员的会话' });
        const sessions = JSON.stringify(await (await call(member, 'GET', '/api/v1/sessions')).json());
        expect(sessions).not.toContain('管理员的会话');
        expect(memberId).toBeTruthy();
    });
});
