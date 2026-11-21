// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import type { ChatChunk, ModelProvider } from '@fatcat-ai/providers';
import { ServerFrame } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';
import { ClientCalls } from './client-calls.js';
import { attachWebSocket, WS_PATH } from './ws.js';

let s: TestServer;
let server: Server;
let detach: { close(): void };
const sockets: WebSocket[] = [];

afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    detach?.close();
    await new Promise<void>((r) => server?.close(() => r()));
    await s?.cleanup();
});

const provider: ModelProvider = {
    profileId: 'fake',
    async *stream(): AsyncGenerator<ChatChunk> {
        yield { type: 'text-delta', delta: 'a' };
        yield { type: 'text-delta', delta: 'b' };
        yield { type: 'finish', reason: 'stop' };
    },
    test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
};

async function start(clientCalls?: ClientCalls) {
    s = await createTestServer({}, { provider });
    server = serve({ fetch: s.app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
    await new Promise<void>((r) => server.once('listening', () => r()));
    detach = attachWebSocket(server, {
        repos: s.repos,
        bus: s.bus,
        logger: (await import('./log.js')).createLogger({ level: 'error' }),
        ...(clientCalls ? { clientCalls } : {}),
    });
    const port = (server.address() as AddressInfo).port;

    const setup = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(setup);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const post = (path: string, body: unknown = {}) =>
        s.app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    await post('/api/v1/models', {
        label: 'fake',
        kind: 'openai-compatible',
        baseURL: 'http://fake.test/v1',
        apiKeyRef: null,
        model: 'm',
        purpose: ['chat'],
    });
    const token = ((await (await post('/api/v1/tokens', { name: 'ws' })).json()) as { token: string }).token;
    const session = ((await (await post('/api/v1/sessions')).json()) as { id: string }).id;
    const chat = async () => {
        await post(`/api/v1/sessions/${session}/messages?stream=false`, { text: 'hi' });
        await s.runs.idle();
    };
    return { port, token, cookie, csrf, chat, session, post };
}

/** 连接并收集服务器帧。 */
function connect(port: number, headers: Record<string, string>, protocols?: string[]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, protocols ?? [], { headers });
    sockets.push(ws);
    const frames: ServerFrame[] = [];
    const waiters: (() => void)[] = [];
    ws.on('message', (data) => {
        frames.push(ServerFrame.parse(JSON.parse(String(data))));
        waiters.splice(0).forEach((w) => w());
    });
    const opened = new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        ws.once('error', reject);
    });
    const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 3000;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error('timeout waiting for frames');
            await new Promise<void>((r) => {
                waiters.push(r);
                setTimeout(r, 50);
            });
        }
    };
    const hello = (lastSeq?: number) =>
        ws.send(
            JSON.stringify({
                v: 1,
                type: 'hello',
                id: 'c1',
                payload: { protocolVersion: 1, ...(lastSeq === undefined ? {} : { lastSeq }) },
            }),
        );
    const seqs = () => frames.filter((f) => f.type === 'event').map((f) => (f as { seq: number }).seq);
    return { ws, frames, opened, until, hello, seqs };
}

describe('WebSocket /api/v1/ws 设备令牌', () => {
    it('设备 access 令牌可放在子协议里握手;PAT 不接受这种方式,伪造和吊销后的令牌被拒', async () => {
        const { port, token, post, cookie, csrf } = await start();
        const code = ((await (await post('/api/v1/devices/pairing-codes')).json()) as { code: string }).code;
        const paired = (await (
            await s.app.request('/api/v1/devices/pair', jsonBody({ code, name: 'phone' }))
        ).json()) as { accessToken: string; device: { id: string } };

        const ok = connect(port, {}, ['fatcat.v1', `fatcat.bearer.${paired.accessToken}`]);
        await ok.opened;
        expect(ok.ws.protocol).toBe('fatcat.v1'); // 令牌子协议不回显
        ok.hello(0);
        await ok.until(() => ok.frames.length > 0);
        expect(ok.frames[0]).toMatchObject({ type: 'welcome' });

        await expect(connect(port, {}, ['fatcat.v1', `fatcat.bearer.${token}`]).opened).rejects.toThrow('HTTP 401');
        await expect(connect(port, {}, ['fatcat.v1', 'fatcat.bearer.aip_dev_forged']).opened).rejects.toThrow(
            'HTTP 401',
        );

        const revoked = await s.app.request(`/api/v1/devices/${paired.device.id}`, {
            method: 'DELETE',
            headers: { cookie, 'X-CSRF-Token': csrf },
        });
        expect(revoked.status).toBe(204);
        await expect(connect(port, {}, ['fatcat.v1', `fatcat.bearer.${paired.accessToken}`]).opened).rejects.toThrow(
            'HTTP 401',
        );
    });
});

describe('设备吊销断开已建立的 WebSocket', () => {
    async function pairedSocket(ctx: Awaited<ReturnType<typeof start>>) {
        const code = ((await (await ctx.post('/api/v1/devices/pairing-codes')).json()) as { code: string }).code;
        const tokens = (await (await s.app.request('/api/v1/devices/pair', jsonBody({ code, name: 'p' }))).json()) as {
            accessToken: string;
            refreshToken: string;
            device: { id: string };
        };
        const c = connect(ctx.port, {}, ['fatcat.v1', `fatcat.bearer.${tokens.accessToken}`]);
        await c.opened;
        c.hello(0);
        await c.until(() => c.frames.length > 0);
        const closed = new Promise<{ code: number; reason: string }>((r) =>
            c.ws.once('close', (code, reason) => r({ code, reason: String(reason) })),
        );
        return { tokens, closed };
    }

    it('业主吊销、设备自己登出、refresh 重放吊销都会关闭该设备的连接(4401)', async () => {
        const ctx = await start();
        const owner = await pairedSocket(ctx);
        const revoked = await s.app.request(`/api/v1/devices/${owner.tokens.device.id}`, {
            method: 'DELETE',
            headers: { cookie: ctx.cookie, 'X-CSRF-Token': ctx.csrf },
        });
        expect(revoked.status).toBe(204);
        expect(await owner.closed).toEqual({ code: 4401, reason: 'device revoked' });

        const self = await pairedSocket(ctx);
        const out = await s.app.request('/api/v1/devices/self', {
            method: 'DELETE',
            headers: { authorization: `Bearer ${self.tokens.accessToken}` },
        });
        expect(out.status).toBe(204);
        expect((await self.closed).code).toBe(4401);

        const replayed = await pairedSocket(ctx);
        const refresh = (token: string) => s.app.request('/api/v1/devices/token', jsonBody({ refreshToken: token }));
        expect((await refresh(replayed.tokens.refreshToken)).status).toBe(200);
        expect((await refresh(replayed.tokens.refreshToken)).status).toBe(401); // 重放:设备被吊销
        expect((await replayed.closed).code).toBe(4401);
    });
});

describe('WebSocket /api/v1/ws', () => {
    it('未登录、Cookie 缺少同源 Origin 时拒绝握手', async () => {
        const { port, cookie } = await start();
        await expect(connect(port, {}).opened).rejects.toThrow('HTTP 401');
        await expect(connect(port, { cookie }).opened).rejects.toThrow('HTTP 403');
        await expect(connect(port, { cookie, origin: 'https://evil.example' }).opened).rejects.toThrow('HTTP 403');
        await expect(connect(port, { authorization: 'Bearer aip_pat_forged' }).opened).rejects.toThrow('HTTP 401');
        await connect(port, { cookie, origin: `http://127.0.0.1:${port}` }).opened;
    });

    it('lastSeq 之后的事件先补发再实时推送,断线重连不重不漏', async () => {
        const { port, token, chat } = await start();
        const auth = { authorization: `Bearer ${token}` };
        await chat(); // 连接前已有的一次运行

        const first = connect(port, auth);
        await first.opened;
        first.hello(0);
        await first.until(() => first.seqs().length >= 5);
        const welcome = first.frames[0]!;
        expect(welcome).toMatchObject({ type: 'welcome', payload: { protocolVersion: 1, replayComplete: true } });
        const before = first.seqs();

        await chat(); // 连接中发生的运行:实时推送
        await first.until(() => first.seqs().length >= before.length * 2);
        const all = first.seqs();
        expect(all).toEqual([...new Set(all)].sort((a, b) => a - b)); // 递增且无重复

        // 断开,期间又有一次运行;带 lastSeq 重连只补发之后的事件
        const lastSeen = all.at(-1)!;
        first.ws.close();
        await chat();
        const second = connect(port, auth);
        await second.opened;
        second.hello(lastSeen);
        await second.until(() => second.seqs().length >= before.length);
        expect(second.seqs().every((seq) => seq > lastSeen)).toBe(true);
        const stored = s.repos.events
            .listAfter(s.repos.owners.getByUsername('owner')!.id, lastSeen, 100)
            .map((e) => e.seq);
        expect(second.seqs()).toEqual(stored);
    });

    it('不带 lastSeq 只接收实时事件;ping 得到 pong;非法帧关闭连接', async () => {
        const { port, token, chat } = await start();
        await chat();
        const c = connect(port, { authorization: `Bearer ${token}` });
        await c.opened;
        c.hello();
        await c.until(() => c.frames.some((f) => f.type === 'welcome'));
        expect(c.seqs()).toEqual([]);
        c.ws.send(JSON.stringify({ v: 1, type: 'ping', id: 'p1', payload: {} }));
        await c.until(() => c.frames.some((f) => f.type === 'pong'));
        await chat();
        await c.until(() => c.seqs().length > 0);

        const closed = new Promise<number>((r) => c.ws.once('close', (code) => r(code)));
        c.ws.send('not json');
        expect(await closed).toBe(4400);
    });

    it('voice-state 转成带文字的 assistant-state 推给所有端;断开时补发 idle;超出每秒上限的丢弃', async () => {
        const { port, token, chat, session } = await start();
        const auth = { authorization: `Bearer ${token}` };
        const speaker = connect(port, auth);
        const watcher = connect(port, auth);
        await Promise.all([speaker.opened, watcher.opened]);
        speaker.hello();
        watcher.hello();
        await speaker.until(() => speaker.frames.some((f) => f.type === 'welcome'));
        await watcher.until(() => watcher.frames.some((f) => f.type === 'welcome'));
        const report = (state: string, sessionId: string | null = session) =>
            speaker.ws.send(JSON.stringify({ v: 1, type: 'voice-state', id: 'v', payload: { state, sessionId } }));
        const states = () =>
            watcher.frames.flatMap((f) =>
                f.type === 'event' && f.payload.event.type === 'assistant-state'
                    ? [{ ...f.payload.event, sessionId: f.payload.sessionId }]
                    : [],
            );

        report('listening');
        await watcher.until(() => states().length >= 1);
        expect(states()[0]).toEqual({
            type: 'assistant-state',
            state: 'listening',
            label: '正在听…',
            sessionId: session,
        });
        // 不属于本人的会话按 null 处理
        report('speaking', '01J00000000000000000000000');
        await watcher.until(() => states().length >= 2);
        expect(states()[1]).toMatchObject({ state: 'speaking', label: '正在朗读…', sessionId: null });

        // 断开时还在朗读:服务器替它发 idle
        speaker.ws.close();
        await watcher.until(() => states().length >= 3);
        expect(states()[2]).toMatchObject({ state: 'idle' });

        // runner 发出的状态也带文字
        await chat();
        await watcher.until(() => states().some((e) => e.state === 'thinking'));
        expect(states().find((e) => e.state === 'thinking')).toMatchObject({ label: '正在思考…' });

        // 每秒最多 5 个(按用户计,前面已用掉 2 个),等进入下一个窗口;多余的丢弃且不断开
        await new Promise((r) => setTimeout(r, 1100));
        const burst = connect(port, auth);
        await burst.opened;
        burst.hello();
        await burst.until(() => burst.frames.some((f) => f.type === 'welcome'));
        const before = states().length;
        for (let i = 0; i < 8; i++) {
            burst.ws.send(
                JSON.stringify({ v: 1, type: 'voice-state', id: `b${i}`, payload: { state: 'idle', sessionId: null } }),
            );
        }
        burst.ws.send(JSON.stringify({ v: 1, type: 'ping', id: 'p', payload: {} }));
        await burst.until(() => burst.frames.some((f) => f.type === 'pong'));
        await watcher.until(() => states().length >= before + 5);
        await new Promise((r) => setTimeout(r, 100));
        expect(states().length - before).toBe(5);
    });

    it('一个端断开时,其他端仍在听就保持那一端的状态,不置为 idle', async () => {
        const { port, token, session } = await start();
        const auth = { authorization: `Bearer ${token}` };
        const [a, b, watcher] = [connect(port, auth), connect(port, auth), connect(port, auth)];
        await Promise.all([a.opened, b.opened, watcher.opened]);
        for (const c of [a, b, watcher]) {
            c.hello();
            await c.until(() => c.frames.some((f) => f.type === 'welcome'));
        }
        const report = (c: typeof a, state: string) =>
            c.ws.send(JSON.stringify({ v: 1, type: 'voice-state', id: 'v', payload: { state, sessionId: session } }));
        const states = () =>
            watcher.frames.flatMap((f) =>
                f.type === 'event' && f.payload.event.type === 'assistant-state' ? [f.payload.event.state] : [],
            );

        report(b, 'speaking');
        await watcher.until(() => states().length >= 1);
        report(a, 'listening');
        await watcher.until(() => states().length >= 2);
        a.ws.close();
        await watcher.until(() => states().length >= 3);
        expect(states()[2]).toBe('speaking');
        b.ws.close();
        await watcher.until(() => states().length >= 4);
        expect(states()).toEqual(['speaking', 'listening', 'speaking', 'idle']);
    });

    it('voice-state 必须在 hello 之后', async () => {
        const { port, token } = await start();
        const c = connect(port, { authorization: `Bearer ${token}` });
        await c.opened;
        const closed = new Promise<number>((r) => c.ws.once('close', (code) => r(code)));
        c.ws.send(JSON.stringify({ v: 1, type: 'voice-state', id: 'v', payload: { state: 'idle', sessionId: null } }));
        expect(await closed).toBe(4400);
    });
});

describe('WebSocket client-call 帧(ADR 0046 第 14 节)', () => {
    it('只有 hello 之后声明了 browser 能力的连接才收到 client-call;没声明的连接收不到', async () => {
        const calls = new ClientCalls();
        const { port, cookie } = await start(calls);
        const origin = `http://127.0.0.1:${port}`;
        const desktop = connect(port, { cookie, origin });
        const plain = connect(port, { cookie, origin });
        await Promise.all([desktop.opened, plain.opened]);
        desktop.hello();
        plain.hello();
        await Promise.all([
            desktop.until(() => desktop.frames.length >= 1),
            plain.until(() => plain.frames.length >= 1),
        ]);
        const ownerId = s.repos.owners.ids()[0]!;
        expect(calls.hasBrowser(ownerId)).toBe(false);
        desktop.ws.send(JSON.stringify({ v: 1, type: 'client-capabilities', id: 'c2', payload: { browser: true } }));
        const deadline = Date.now() + 2000;
        while (!calls.hasBrowser(ownerId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        expect(calls.hasBrowser(ownerId)).toBe(true);

        const pending = calls.request(
            ownerId,
            { tool: 'browser.screenshot', url: 'https://a.example/' },
            { signal: new AbortController().signal, timeoutMs: 200 },
        );
        await desktop.until(() => desktop.frames.some((f) => f.type === 'client-call'));
        expect(plain.frames.some((f) => f.type === 'client-call')).toBe(false);
        await expect(pending).rejects.toMatchObject({ code: 'timeout' });

        desktop.ws.close();
        const gone = Date.now() + 2000;
        while (calls.hasBrowser(ownerId) && Date.now() < gone) await new Promise((r) => setTimeout(r, 20));
        expect(calls.hasBrowser(ownerId)).toBe(false);
    });
});
