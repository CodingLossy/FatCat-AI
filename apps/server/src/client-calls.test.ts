// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 客户端执行的调用(ADR 0046 第 14 节):注册表、截图宿主适配器、POST /tool-calls/{id}/result 的越权与重复用例。
import type { ClientCall, ClientCallResult } from '@fatcat-ai/shared';
import type { ToolContext } from '@fatcat-ai/tools';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientCalls, createClientBrowserHost, createClientOpenHost } from './client-calls.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
const png = (overrides: Partial<Extract<ClientCallResult, { ok: true }>> = {}): ClientCallResult => ({
    ok: true,
    mimeType: 'image/png',
    width: 800,
    height: 600,
    data: PNG,
    ...overrides,
});

/** 一个声明了 browser 能力、并按给定回答立即作答的假桌面客户端。 */
function desktop(calls: ClientCalls, ownerId: string, answer: (call: ClientCall) => ClientCallResult | null) {
    const seen: ClientCall[] = [];
    const handle = calls.register(ownerId, {
        send: (call) => {
            seen.push(call);
            const result = answer(call);
            if (result) queueMicrotask(() => calls.complete(ownerId, call.callId, result));
        },
    });
    handle.declare({ browser: true });
    return { seen, handle };
}

const context = { ownerId: 'o1' } as ToolContext;
const never = new AbortController().signal;

describe('ClientCalls 与截图宿主适配器', () => {
    it('没有声明能力的连接时返回 browser_unavailable,不会悄悄改用别的方式', async () => {
        const calls = new ClientCalls();
        const host = createClientBrowserHost(calls);
        await expect(host.screenshot('https://a.example/', never, context)).rejects.toMatchObject({
            code: 'browser_unavailable',
        });
        // 连接存在但没有声明能力,仍然不可用
        calls.register('o1', { send: () => undefined });
        await expect(host.screenshot('https://a.example/', never, context)).rejects.toMatchObject({
            code: 'browser_unavailable',
        });
    });

    it('截图成功:收到 client-call 帧,返回的字节必须真的是声明的图像格式', async () => {
        const calls = new ClientCalls();
        const { seen } = desktop(calls, 'o1', () => png());
        const host = createClientBrowserHost(calls);
        const image = await host.screenshot('https://a.example/x', never, context);
        expect(seen[0]).toMatchObject({ tool: 'browser.screenshot', url: 'https://a.example/x' });
        expect(seen[0]?.callId).toMatch(/^cc_/);
        expect(image).toMatchObject({ mimeType: 'image/png', width: 800, height: 600 });

        const fake = Buffer.from('not an image').toString('base64');
        desktop(calls, 'o2', () => png({ data: fake }));
        await expect(host.screenshot('https://a.example/', never, { ownerId: 'o2' } as ToolContext)).rejects.toThrow(
            /not a valid image/,
        );
    });

    it('结果只对本人、仅一次、迟到的拒绝;超时与取消都以工具错误结束', async () => {
        const calls = new ClientCalls();
        let id = '';
        desktop(calls, 'o1', (call) => {
            id = call.callId;
            return null;
        });
        const pending = calls.request(
            'o1',
            { tool: 'browser.screenshot', url: 'https://a.example/' },
            { signal: never },
        );
        expect(calls.complete('o2', id, png())).toBe('not_found');
        expect(calls.complete('o1', 'cc_unknown0000000000', png())).toBe('not_found');
        expect(calls.complete('o1', id, png())).toBe('ok');
        await expect(pending).resolves.toMatchObject({ ok: true });
        expect(calls.complete('o1', id, png())).toBe('conflict');

        const slow = calls.request(
            'o1',
            { tool: 'browser.screenshot', url: 'https://a.example/' },
            {
                signal: never,
                timeoutMs: 10,
            },
        );
        await expect(slow).rejects.toMatchObject({ code: 'timeout' });
        const controller = new AbortController();
        const cancelled = calls.request(
            'o1',
            { tool: 'browser.screenshot', url: 'https://a.example/' },
            {
                signal: controller.signal,
            },
        );
        controller.abort();
        await expect(cancelled).rejects.toMatchObject({ code: 'timeout' });
    });

    it('同一个人同时进行的调用有上限', async () => {
        const calls = new ClientCalls();
        desktop(calls, 'o1', () => null);
        const open = () =>
            calls.request(
                'o1',
                { tool: 'browser.screenshot', url: 'https://a.example/' },
                { signal: never, timeoutMs: 50 },
            );
        const started = [open(), open(), open(), open()];
        await expect(open()).rejects.toMatchObject({ code: 'busy' });
        await Promise.allSettled(started);
    });
});

describe('POST /api/v1/tool-calls/{callId}/result', () => {
    let s: TestServer;
    afterEach(async () => {
        await s?.cleanup();
    });

    async function setup() {
        const calls = new ClientCalls();
        s = await createTestServer({}, { clientCalls: calls });
        const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
        const { cookie, csrf } = sessionFrom(res);
        const ownerId = s.repos.owners.ids()[0]!;
        const post = (callId: string, body: unknown, headers: Record<string, string> = {}) =>
            s.app.request(`/api/v1/tool-calls/${callId}/result`, {
                method: 'POST',
                headers: { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json', ...headers },
                body: JSON.stringify(body),
            });
        return { calls, ownerId, post };
    }

    it('没有会话 401;未知调用 404;结果格式不对 400;图像不是 png / jpeg 400', async () => {
        const { calls, ownerId, post } = await setup();
        const anon = await s.app.request('/api/v1/tool-calls/cc_abcdefghijklmnop/result', jsonBody(png()));
        expect(anon.status).toBe(401);
        expect((await post('cc_abcdefghijklmnop', png())).status).toBe(404);
        expect((await post('cc_abcdefghijklmnop', { ok: true })).status).toBe(400);
        expect((await post('not-a-call-id', png())).status).toBe(400);
        expect((await post('cc_abcdefghijklmnop', png({ mimeType: 'image/svg+xml' as 'image/png' }))).status).toBe(400);
        expect(calls.hasBrowser(ownerId)).toBe(false);
    });

    it('等待中的调用只接受一次结果:第二次 409', async () => {
        const { calls, ownerId, post } = await setup();
        let id = '';
        desktop(calls, ownerId, (call) => {
            id = call.callId;
            return null;
        });
        const pending = calls.request(
            ownerId,
            { tool: 'browser.screenshot', url: 'https://a.example/' },
            { signal: never },
        );
        expect((await post(id, png())).status).toBe(204);
        await expect(pending).resolves.toMatchObject({ ok: true });
        expect((await post(id, png())).status).toBe(409);
    });
});

describe('system.open 的宿主适配器(ADR 0046 第 5 节)', () => {
    const target = { kind: 'file', path: '/home/me/a.pdf' } as const;

    it('只发给声明了 open 能力的连接;只声明了浏览器的旧桌面客户端收不到', async () => {
        const calls = new ClientCalls();
        const { seen: browserOnly } = desktop(calls, 'o1', () => ({ ok: true, opened: true }));
        const host = createClientOpenHost(calls);
        await expect(host.open(target, never, context)).rejects.toMatchObject({ code: 'desktop_unavailable' });
        expect(browserOnly).toHaveLength(0);

        const seen: ClientCall[] = [];
        const handle = calls.register('o1', {
            send: (call) => {
                seen.push(call);
                queueMicrotask(() => calls.complete('o1', call.callId, { ok: true, opened: true }));
            },
        });
        handle.declare({ browser: true, open: true });
        await host.open(target, never, context);
        expect(seen[0]).toMatchObject({ tool: 'system.open', target });
        expect(browserOnly).toHaveLength(0);
    });

    it('别人的连接收不到;壳拒绝或答非所问时失败', async () => {
        const calls = new ClientCalls();
        const other: ClientCall[] = [];
        calls.register('o2', { send: (c) => other.push(c) }).declare({ browser: true, open: true });
        const host = createClientOpenHost(calls);
        await expect(host.open(target, never, context)).rejects.toMatchObject({ code: 'desktop_unavailable' });
        expect(other).toHaveLength(0);

        const answers: ClientCallResult[] = [{ ok: false, code: 'blocked' }, png()];
        calls
            .register('o1', {
                send: (call) => queueMicrotask(() => calls.complete('o1', call.callId, answers.shift()!)),
            })
            .declare({ browser: false, open: true });
        await expect(host.open(target, never, context)).rejects.toMatchObject({ code: 'blocked' });
        await expect(host.open(target, never, context)).rejects.toMatchObject({ code: 'failed' });
    });
});
