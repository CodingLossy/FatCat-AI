// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ChatChunk, ChatRequest, ModelProvider } from '@fatcat-ai/providers';
import { EventEnvelope, Message, ProblemDetails, Session } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

type Script = (request: ChatRequest) => AsyncGenerator<ChatChunk>;

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

const hello: Script = async function* () {
    yield { type: 'text-delta', delta: '你好' };
    yield { type: 'text-delta', delta: ',世界' };
    yield { type: 'finish', reason: 'stop', usage: { outputTokens: 2 } };
};

/** 可替换脚本的假 provider。 */
function fakeProvider() {
    const state: { script: Script; requests: ChatRequest[] } = { script: hello, requests: [] };
    const provider: ModelProvider = {
        profileId: 'fake',
        stream: (request) => {
            state.requests.push(request);
            return state.script(request);
        },
        test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
    };
    return { provider, state };
}

/** 可从测试中放行的闸门。 */
function gate() {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    return { open, opened };
}

function parseSse(text: string): { id: number; envelope: EventEnvelope }[] {
    return text
        .split('\n\n')
        .filter((block) => block.includes('data:'))
        .map((block) => {
            const id = Number(/^id: (\d+)$/m.exec(block)![1]);
            const data = /^data: (.*)$/m.exec(block)![1]!;
            return { id, envelope: EventEnvelope.parse(JSON.parse(data)) };
        });
}

async function setup(options: { withProfile?: boolean; apiKeyRef?: string | null } = {}) {
    const fake = fakeProvider();
    s = await createTestServer({}, { provider: fake.provider, env: {} });
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const req = (path: string, init: RequestInit = {}) =>
        s.app.request(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
    const post = (path: string, body: unknown = {}) => req(path, { method: 'POST', body: JSON.stringify(body) });
    if (options.withProfile !== false) {
        await post('/api/v1/models', {
            label: 'fake',
            kind: 'openai-compatible',
            baseURL: 'http://fake.test/v1',
            apiKeyRef: options.apiKeyRef ?? null,
            model: 'm',
            purpose: ['chat'],
        });
    }
    const session = Session.parse(await (await post('/api/v1/sessions')).json());
    const send = (body: unknown, query = '') => post(`/api/v1/sessions/${session.id}/messages${query}`, body);
    const messages = async () =>
        ((await (await req(`/api/v1/sessions/${session.id}/messages`)).json()) as { items: Message[] }).items;
    return { fake, req, post, session, send, messages };
}

describe('发送消息(SSE)', () => {
    it('流式返回事件,结束后关闭;消息与会话标题落库', async () => {
        const { send, messages, req, session } = await setup();
        const res = await send({ text: '请问好' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const events = parseSse(await res.text());

        expect(events.map((e) => e.envelope.event.type)).toEqual([
            'run-started',
            'assistant-state',
            'text-delta',
            'text-delta',
            'run-finished',
        ]);
        expect(events.map((e) => e.id)).toEqual(events.map((e) => e.envelope.seq));
        expect([...events.map((e) => e.id)].sort((a, b) => a - b)).toEqual(events.map((e) => e.id));

        const items = await messages();
        expect(items.map((m) => [m.role, m.status])).toEqual([
            ['user', 'complete'],
            ['assistant', 'complete'],
        ]);
        expect(items[1]!.parts).toEqual([{ type: 'text', text: '你好,世界' }]);
        expect(Session.parse(await (await req(`/api/v1/sessions/${session.id}`)).json()).title).toBe('请问好');
    });

    it('stream=false 返回 202,之后可完整续看', async () => {
        const { send, req } = await setup();
        const accepted = (await (await send({ text: 'x' }, '?stream=false')).json()) as { runId: string };
        await s.runs.idle();
        const replay = parseSse(await (await req(`/api/v1/runs/${accepted.runId}/events`)).text());
        expect(replay.at(-1)!.envelope.event.type).toBe('run-finished');
        expect(replay[0]!.envelope.event.type).toBe('run-started');
    });
});

describe('断线续看', () => {
    it('Last-Event-ID 之后的事件不重不漏,拼起来与落库正文一致', async () => {
        const { send, req, fake, messages } = await setup();
        const g = gate();
        fake.state.script = async function* () {
            yield { type: 'text-delta', delta: '前半段' };
            await g.opened;
            yield { type: 'text-delta', delta: '后半段' };
            yield { type: 'finish', reason: 'stop' };
        };
        // 订阅总线,等第一个文本增量落库
        let firstSeq = 0;
        const sawFirst = new Promise<void>((resolve) => {
            const off = s.bus.subscribe(ownerOf(s), (e) => {
                if (e.event.type === 'text-delta' && !firstSeq) {
                    firstSeq = e.seq;
                    off();
                    resolve();
                }
            });
        });
        const { runId } = (await (await send({ text: 'x' }, '?stream=false')).json()) as { runId: string };
        await sawFirst;

        // 第一个连接「断开」后,用 Last-Event-ID 续看
        const resumed = req(`/api/v1/runs/${runId}/events`, { headers: { 'Last-Event-ID': String(firstSeq) } });
        g.open();
        const rest = parseSse(await (await resumed).text());
        expect(rest.every((e) => e.id > firstSeq)).toBe(true);
        const deltas = rest
            .map((e) => e.envelope.event)
            .filter((e) => e.type === 'text-delta')
            .map((e) => (e as { delta: string }).delta);
        expect(['前半段', ...deltas].join('')).toBe('前半段后半段');
        expect((await messages())[1]!.parts).toEqual([{ type: 'text', text: '前半段后半段' }]);
    });
});

function ownerOf(server: TestServer): string {
    return server.repos.owners.getByUsername('owner')!.id;
}

describe('取消、冲突、幂等', () => {
    it('取消进行中的运行;已结束的运行再取消返回 409', async () => {
        const { send, post, fake } = await setup();
        fake.state.script = async function* (request) {
            yield { type: 'text-delta', delta: '部分' };
            await new Promise<void>((r) => request.signal?.addEventListener('abort', () => r()));
            yield { type: 'finish', reason: 'aborted' };
        };
        const res = await send({ text: 'x' });
        const stream = res.text();
        const run = s.repos.runs.listActive(ownerOf(s))[0]!;
        await new Promise((r) => setTimeout(r, 20));
        expect((await post(`/api/v1/runs/${run.id}/cancel`)).status).toBe(202);
        const events = parseSse(await stream);
        expect(events.at(-1)!.envelope.event).toEqual({ type: 'run-finished', runId: run.id, reason: 'cancelled' });
        const again = await post(`/api/v1/runs/${run.id}/cancel`);
        expect(again.status).toBe(409);
        expect(ProblemDetails.parse(await again.json()).code).toBe('run_not_active');
    });

    it('同一会话已有运行时返回 409', async () => {
        const { send, fake } = await setup();
        const g = gate();
        fake.state.script = async function* () {
            await g.opened;
            yield { type: 'finish', reason: 'stop' };
        };
        expect((await send({ text: 'a' }, '?stream=false')).status).toBe(202);
        const second = await send({ text: 'b' }, '?stream=false');
        expect(second.status).toBe(409);
        expect(ProblemDetails.parse(await second.json()).code).toBe('conflict');
        g.open();
    });

    it('相同 clientMessageId 重复提交返回同一个运行', async () => {
        const { send, messages } = await setup();
        const a = (await (await send({ text: 'x', clientMessageId: 'c-1' }, '?stream=false')).json()) as {
            runId: string;
        };
        await s.runs.idle();
        const b = (await (await send({ text: 'x', clientMessageId: 'c-1' }, '?stream=false')).json()) as {
            runId: string;
        };
        expect(b.runId).toBe(a.runId);
        expect(await messages()).toHaveLength(2);
    });
});

describe('模型配置档', () => {
    it('没有配置档或引用的密钥不存在时返回 409', async () => {
        const none = await setup({ withProfile: false });
        const r1 = await none.send({ text: 'x' });
        expect(r1.status).toBe(409);
        expect(ProblemDetails.parse(await r1.json()).code).toBe('model_profile_missing');
        await s.cleanup();

        const missing = await setup({ apiKeyRef: 'env:NOT_SET_ANYWHERE' });
        const r2 = await missing.send({ text: 'x' });
        expect(r2.status).toBe(409);
        expect(ProblemDetails.parse(await r2.json()).code).toBe('model_key_missing');
    });
});

describe('重试与重新生成', () => {
    it('失败的运行可以重试,新回复关联到失败的那条', async () => {
        const { send, post, fake, messages } = await setup();
        fake.state.script = async function* () {
            yield { type: 'text-delta', delta: '半' };
            throw new Error('boom');
        };
        const failed = parseSse(await (await send({ text: 'x' })).text());
        expect(failed.at(-1)!.envelope.event.type).toBe('run-failed');
        const runId = (failed[0]!.envelope.event as { runId: string }).runId;

        fake.state.script = hello;
        const retried = parseSse(await (await post(`/api/v1/runs/${runId}/retry`)).text());
        expect(retried.at(-1)!.envelope.event.type).toBe('run-finished');

        const items = await messages();
        expect(items.map((m) => [m.role, m.status])).toEqual([
            ['user', 'complete'],
            ['assistant', 'error'],
            ['assistant', 'complete'],
        ]);
        expect(items[2]!.parentMessageId).toBe(items[1]!.id);

        // 成功的运行不能重试
        const okRun = (retried[0]!.envelope.event as { runId: string }).runId;
        expect((await post(`/api/v1/runs/${okRun}/retry`)).status).toBe(409);
    });

    it('重新生成助手回复,旧回复保留为分支', async () => {
        const { send, post, session, messages } = await setup();
        await (await send({ text: 'x' })).text();
        const answer = (await messages())[1]!;
        const res = await post(`/api/v1/sessions/${session.id}/messages/${answer.id}/regenerate`);
        expect(parseSse(await res.text()).at(-1)!.envelope.event.type).toBe('run-finished');
        const items = await messages();
        expect(items).toHaveLength(3);
        expect(items[2]).toMatchObject({ role: 'assistant', parentMessageId: answer.id, status: 'complete' });

        const user = items[0]!;
        expect((await post(`/api/v1/sessions/${session.id}/messages/${user.id}/regenerate`)).status).toBe(404);
    });
});

describe('会话管理', () => {
    it('删除有进行中运行的会话:先取消,再级联删除', async () => {
        const { send, req, session, fake } = await setup();
        fake.state.script = async function* (request) {
            await new Promise<void>((r) => request.signal?.addEventListener('abort', () => r()));
            yield { type: 'finish', reason: 'aborted' };
        };
        await send({ text: 'x' }, '?stream=false');
        expect((await req(`/api/v1/sessions/${session.id}`, { method: 'DELETE' })).status).toBe(204);
        expect((await req(`/api/v1/sessions/${session.id}`)).status).toBe(404);
        expect(s.repos.runs.listActive(ownerOf(s))).toEqual([]);
    });

    it('列表、改名、引用不存在的配置档返回 400', async () => {
        const { req, post, session } = await setup();
        const renamed = await req(`/api/v1/sessions/${session.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ title: '新标题' }),
        });
        expect(Session.parse(await renamed.json()).title).toBe('新标题');
        const list = (await (await req('/api/v1/sessions?limit=10')).json()) as { items: Session[] };
        expect(list.items.map((x) => x.id)).toEqual([session.id]);
        expect((await post('/api/v1/sessions', { modelProfileId: '01JC0000000000000000000000' })).status).toBe(400);
    });
});
