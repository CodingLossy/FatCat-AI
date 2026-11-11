// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// DELETE /sessions:清空当前主人的全部对话。先停掉运行,再删消息与附件文件;记忆保留;别人的数据不动。
import type { ChatChunk, ChatRequest, ModelProvider } from '@fatcat-ai/providers';
import { Attachment, ProblemDetails, Session } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

/** 1×1 透明 PNG(合成)。 */
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

describe('清空全部对话', () => {
    it('停掉进行中的运行,删掉附件文件,保留记忆,不碰其他主人', async () => {
        let aborted = false;
        const provider: ModelProvider = {
            profileId: 'fake',
            stream: (request: ChatRequest) => {
                const text = JSON.stringify(request.messages);
                if (text.includes('请停一下')) {
                    return (async function* (): AsyncGenerator<ChatChunk> {
                        await new Promise<void>((resolve) => {
                            const finish = () => {
                                aborted = true;
                                resolve();
                            };
                            if (request.signal?.aborted) return finish();
                            request.signal?.addEventListener('abort', finish);
                        });
                        yield { type: 'finish', reason: 'aborted' };
                    })();
                }
                return (async function* (): AsyncGenerator<ChatChunk> {
                    yield { type: 'text-delta', delta: '好' };
                    yield { type: 'finish', reason: 'stop' };
                })();
            },
            test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
        };
        s = await createTestServer({}, { provider });
        const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
        const { cookie, csrf } = sessionFrom(res);
        const auth = { cookie, 'X-CSRF-Token': csrf };
        const req = (path: string, init: RequestInit = {}) =>
            s.app.request(path, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });
        const post = (path: string, body: unknown = {}) =>
            req(path, {
                method: 'POST',
                body: JSON.stringify(body),
                headers: { 'content-type': 'application/json' },
            });
        const ownerId = s.repos.owners.ids()[0]!;
        await post('/api/v1/models', {
            label: 'fake',
            kind: 'openai-compatible',
            baseURL: 'http://fake.test/v1',
            apiKeyRef: null,
            model: 'm',
            purpose: ['chat'],
            vision: true,
        });

        const withFile = Session.parse(await (await post('/api/v1/sessions', { title: '带图' })).json());
        const form = new FormData();
        form.append('file', new File([PNG], 'cat.png', { type: 'image/png' }));
        const uploaded = Attachment.parse(
            await (await req('/api/v1/attachments', { method: 'POST', body: form })).json(),
        );
        expect(
            (
                await post(`/api/v1/sessions/${withFile.id}/messages?stream=false`, {
                    text: '看图',
                    attachmentIds: [uploaded.id],
                })
            ).status,
        ).toBe(202);
        await s.runs.idle();

        const hanging = Session.parse(await (await post('/api/v1/sessions', { title: '进行中' })).json());
        expect((await post(`/api/v1/sessions/${hanging.id}/messages?stream=false`, { text: '请停一下' })).status).toBe(
            202,
        );
        await vi.waitFor(() => expect(s.repos.sessions.get(ownerId, hanging.id)?.activeRunId).toBeTruthy());

        expect((await post('/api/v1/memory', { text: '用户的名字是 Theodore Yin', subtype: 'profile' })).status).toBe(
            200,
        );
        const memoryId = s.repos.memories.list(ownerId, 1)[0]!.id;
        s.conn.sqlite
            .prepare(`INSERT INTO memory_sources (id, memory_id, session_id, created_at) VALUES ('src-clear', ?, ?, ?)`)
            .run(memoryId, withFile.id, '2026-11-11T00:00:00.000Z');
        expect(s.repos.sessions.delete('someone-else', withFile.id)).toBe(false);
        expect(s.repos.sessions.ids('someone-else')).toEqual([]);

        expect((await s.app.request('/api/v1/sessions', { method: 'DELETE' })).status).toBe(401);
        expect((await req('/api/v1/sessions', { method: 'DELETE' })).status).toBe(204);

        expect(aborted).toBe(true);
        expect(s.repos.sessions.ids(ownerId)).toEqual([]);
        expect(await s.attachmentFiles.read(uploaded.id)).toBeNull();
        expect(s.repos.attachments.exists(uploaded.id)).toBe(false);
        expect(s.repos.memories.get(ownerId, memoryId)?.text).toBe('用户的名字是 Theodore Yin');
        expect(s.conn.sqlite.prepare('SELECT session_id AS sessionId FROM memory_sources').get()).toEqual({
            sessionId: null,
        });
    });

    it('未登录不能清空,错误体不含内部细节', async () => {
        s = await createTestServer();
        const res = await s.app.request('/api/v1/sessions', { method: 'DELETE' });
        expect(res.status).toBe(401);
        const problem = ProblemDetails.parse(await res.json());
        expect(problem.code).toBe('unauthorized');
        expect(JSON.stringify(problem)).not.toContain('sqlite');
    });
});
