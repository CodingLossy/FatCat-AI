// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { EventEnvelope } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { createClient } from './client.js';
import { FatCatApiError, FatCatNetworkError } from './errors.js';
import { parseSse } from './sse.js';

const RUN = '01JC0000000000000000000RUN';
const SESSION = '01JC00000000000000000SESS1';

function streamOf(chunks: string[], { error }: { error?: boolean } = {}): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream({
        pull(controller) {
            if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
            else if (error) controller.error(new TypeError('terminated'));
            else controller.close();
        },
    });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
}

const env = (seq: number, event: EventEnvelope['event']): EventEnvelope => ({
    seq,
    at: '2026-11-04T00:00:00.000Z',
    sessionId: SESSION,
    event,
});
const frame = (e: EventEnvelope) => `id: ${e.seq}\nevent: agent\ndata: ${JSON.stringify(e)}\n\n`;
const started = env(1, {
    type: 'run-started',
    runId: RUN,
    sessionId: SESSION,
    userMessageId: '01JC0000000000000000000USR',
    assistantMessageId: '01JC0000000000000000000AST',
});
const delta = (seq: number, text: string) => env(seq, { type: 'text-delta', runId: RUN, delta: text });
const finished = (seq: number) => env(seq, { type: 'run-finished', runId: RUN, reason: 'stop' });

interface Call {
    url: string;
    init: RequestInit;
}
function fakeFetch(responses: (Response | Error)[]) {
    const calls: Call[] = [];
    const fn: typeof fetch = (input, init = {}) => {
        calls.push({ url: String(input), init });
        const next = responses.shift();
        if (!next) return Promise.reject(new Error('no more responses'));
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
    return { fn, calls };
}
const sseResponse = (body: ReadableStream<Uint8Array>) =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

describe('parseSse', () => {
    it('处理任意分块、CRLF、多行 data、注释心跳与 id', async () => {
        const text = ': ping\r\n\r\nid: 7\r\nevent: agent\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: x\n\n';
        // 逐字符切块,覆盖 \r\n 被拆开的情况
        const messages = await collect(parseSse(streamOf(text.split(''))));
        expect(messages).toEqual([
            { id: '7', event: 'agent', data: '{"a":\n1}' },
            { id: '7', event: 'message', data: 'x' },
        ]);
    });

    it('丢弃未以空行结尾的消息', async () => {
        expect(await collect(parseSse(streamOf(['data: half'])))).toEqual([]);
    });
});

describe('请求与鉴权', () => {
    it('令牌用 Bearer 头,不带 Cookie;URL 拼接 /api/v1 与查询参数', async () => {
        const f = fakeFetch([Response.json({ items: [], nextCursor: null })]);
        const client = createClient({ baseUrl: 'http://h:1/', token: 'aip_pat_x', fetch: f.fn });
        await client.sessions.list({ limit: 5 });
        expect(f.calls[0]!.url).toBe('http://h:1/api/v1/sessions?limit=5');
        expect(header(f.calls[0]!, 'authorization')).toBe('Bearer aip_pat_x');
        expect(f.calls[0]!.init.credentials).toBeUndefined();
    });

    it('Cookie 模式下修改类请求带 X-CSRF-Token,GET 不带', async () => {
        const f = fakeFetch([Response.json({}), Response.json({})]);
        const client = createClient({ baseUrl: 'http://h', csrfToken: () => 'csrf1', fetch: f.fn });
        await client.auth.me();
        await client.sessions.create();
        expect(header(f.calls[0]!, 'x-csrf-token')).toBeUndefined();
        expect(header(f.calls[1]!, 'x-csrf-token')).toBe('csrf1');
        expect(f.calls[1]!.init.credentials).toBe('include');
    });

    it('上传附件用 multipart:不设 content-type,带 CSRF;url 指向附件', async () => {
        const f = fakeFetch([Response.json({ id: 'a1' }), new Response(new Uint8Array([1, 2]))]);
        const client = createClient({ baseUrl: 'http://h', csrfToken: () => 'csrf1', fetch: f.fn });
        await client.attachments.upload(new Blob([new Uint8Array([0x89])], { type: 'image/png' }), 'cat.png');
        const body = f.calls[0]!.init.body as FormData;
        expect((body.get('file') as File).name).toBe('cat.png');
        expect(header(f.calls[0]!, 'content-type')).toBeUndefined();
        expect(header(f.calls[0]!, 'x-csrf-token')).toBe('csrf1');
        expect(client.attachments.url('a1')).toBe('http://h/api/v1/attachments/a1');
        expect((await client.attachments.read('a1')).size).toBe(2);
    });

    it('非 2xx 转为 FatCatApiError(保留 problem 字段),无正文时合成', async () => {
        const problem = { title: 'Conflict', status: 409, code: 'conflict', requestId: 'r1', detail: 'busy' };
        const f = fakeFetch([
            new Response(JSON.stringify(problem), { status: 409 }),
            new Response('oops', { status: 502, statusText: 'Bad Gateway', headers: { 'x-request-id': 'r2' } }),
        ]);
        const client = createClient({ baseUrl: 'http://h', token: 'aip_pat_x', fetch: f.fn });
        const e1 = await client.sessions.create().catch((e: unknown) => e);
        expect(e1).toBeInstanceOf(FatCatApiError);
        expect((e1 as FatCatApiError).code).toBe('conflict');
        expect((e1 as FatCatApiError).message).toBe('Conflict: busy');
        const e2 = (await client.meta().catch((e: unknown) => e)) as FatCatApiError;
        expect(e2.status).toBe(502);
        expect(e2.problem.requestId).toBe('r2');
        expect(e2.code).toBe('internal');
    });

    it('连不上时抛 FatCatNetworkError,错误里没有令牌', async () => {
        const f = fakeFetch([new TypeError('fetch failed')]);
        const client = createClient({ baseUrl: 'http://h', token: 'aip_pat_secret', fetch: f.fn });
        const err = (await client.meta().catch((e: unknown) => e)) as Error;
        expect(err).toBeInstanceOf(FatCatNetworkError);
        expect(err.message).not.toContain('aip_pat_secret');
    });
});

describe('RunStream', () => {
    const noWait = { backoffMs: () => 0 };

    it('产出事件直到终止事件,自动生成 clientMessageId', async () => {
        const f = fakeFetch([sseResponse(streamOf([frame(started), frame(delta(2, 'hi')), frame(finished(3))]))]);
        const client = createClient({ baseUrl: 'http://h', token: 'aip_pat_x', fetch: f.fn });
        const stream = client.sessions.send(SESSION, { text: 'hello' });
        const events = await collect(stream);
        expect(events.map((e) => e.event.type)).toEqual(['run-started', 'text-delta', 'run-finished']);
        expect(stream.runId).toBe(RUN);
        const body = JSON.parse(f.calls[0]!.init.body as string) as { clientMessageId: string };
        expect(body.clientMessageId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    });

    it('断线后用 Last-Event-ID 续看,按 seq 去重', async () => {
        const f = fakeFetch([
            sseResponse(streamOf([frame(started), frame(delta(2, 'a'))], { error: true })),
            // 续看时服务器重复发了 seq 2
            sseResponse(streamOf([frame(delta(2, 'a')), frame(delta(3, 'b')), frame(finished(4))])),
        ]);
        const client = createClient({ baseUrl: 'http://h', token: 'aip_pat_x', fetch: f.fn });
        const events = await collect(client.sessions.send(SESSION, { text: 'x' }, noWait));
        expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
        expect(f.calls[1]!.url).toBe(`http://h/api/v1/runs/${RUN}/events`);
        expect(header(f.calls[1]!, 'last-event-id')).toBe('2');
    });

    it('流正常结束但没有终止事件时也续看', async () => {
        const f = fakeFetch([sseResponse(streamOf([frame(started)])), sseResponse(streamOf([frame(finished(2))]))]);
        const client = createClient({ baseUrl: 'http://h', token: 'aip_pat_x', fetch: f.fn });
        expect((await collect(client.sessions.send(SESSION, { text: 'x' }, noWait))).length).toBe(2);
    });

    it('收到 run-started 之前断线时,用同一个 clientMessageId 重发', async () => {
        const f = fakeFetch([
            new TypeError('fetch failed'),
            sseResponse(streamOf([frame(started), frame(finished(2))])),
        ]);
        const client = createClient({ baseUrl: 'http://h', token: 'aip_pat_x', fetch: f.fn });
        await collect(client.sessions.send(SESSION, { text: 'x' }, noWait));
        expect(f.calls.map((c) => c.init.method)).toEqual(['POST', 'POST']);
        expect(f.calls[0]!.init.body).toBe(f.calls[1]!.init.body);
    });

    it('服务器明确拒绝(409)时不重试', async () => {
        const problem = { title: 'Conflict', status: 409, code: 'conflict', requestId: 'r' };
        const f = fakeFetch([new Response(JSON.stringify(problem), { status: 409 })]);
        const client = createClient({ baseUrl: 'http://h', token: 'aip_pat_x', fetch: f.fn });
        await expect(collect(client.sessions.send(SESSION, { text: 'x' }, noWait))).rejects.toBeInstanceOf(
            FatCatApiError,
        );
        expect(f.calls).toHaveLength(1);
    });

    it('续看次数用尽后抛 FatCatNetworkError', async () => {
        const f = fakeFetch([
            sseResponse(streamOf([frame(started)])),
            new TypeError('fetch failed'),
            new TypeError('fetch failed'),
        ]);
        const client = createClient({ baseUrl: 'http://h', token: 'aip_pat_x', fetch: f.fn });
        const stream = client.sessions.send(SESSION, { text: 'x' }, { ...noWait, maxReconnects: 2 });
        await expect(collect(stream)).rejects.toBeInstanceOf(FatCatNetworkError);
        expect(f.calls).toHaveLength(3);
    });

    it('runs.events 从给定 seq 续看', async () => {
        const f = fakeFetch([sseResponse(streamOf([frame(delta(5, 'z')), frame(finished(6))]))]);
        const client = createClient({ baseUrl: 'http://h', token: 'aip_pat_x', fetch: f.fn });
        const events = await collect(client.runs.events(RUN, 4));
        expect(events.map((e) => e.seq)).toEqual([5, 6]);
        expect(header(f.calls[0]!, 'last-event-id')).toBe('4');
    });
});

describe('令牌换取', () => {
    it('登录 → 用 Cookie 与 CSRF 建令牌 → 登出', async () => {
        const login = new Response(
            JSON.stringify({ owner: { id: 'o', username: 'owner' }, csrfToken: 'c1', expiresAt: 'x' }),
            {
                status: 200,
                headers: [
                    ['set-cookie', 'aip_session=s1; HttpOnly'],
                    ['set-cookie', 'aip_csrf=c1'],
                ],
            },
        );
        const token = { id: 't', name: 'cli', token: 'aip_pat_new', createdAt: 'x', lastUsedAt: null, expiresAt: null };
        const f = fakeFetch([login, Response.json(token, { status: 201 }), new Response(null, { status: 204 })]);
        const client = createClient({ baseUrl: 'http://h', fetch: f.fn });
        const result = await client.auth.loginForToken({ username: 'owner', password: 'p', tokenName: 'cli' });
        expect(result.token.token).toBe('aip_pat_new');
        expect(f.calls.map((c) => c.url)).toEqual([
            'http://h/api/v1/auth/login',
            'http://h/api/v1/tokens',
            'http://h/api/v1/auth/logout',
        ]);
        expect(header(f.calls[1]!, 'cookie')).toBe('aip_session=s1; aip_csrf=c1');
        expect(header(f.calls[1]!, 'x-csrf-token')).toBe('c1');
    });
});
