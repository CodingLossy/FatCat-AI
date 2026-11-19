// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// ADR 0045 第 1 节:设备配对与设备令牌。含越权用例:设备令牌不能创建设备 / 令牌、不能改账户设置。
import { CreatedPairingCode, DeviceEvent, DeviceTokens } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FailureLimiter } from './auth/rate-limit.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(() => s?.cleanup());

async function boot(pairLimiter = new FailureLimiter(5, 60_000)) {
    s = await createTestServer({}, { pairLimiter });
    const session = sessionFrom(
        await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD })),
    );
    const withSession = (method: string, path: string, body?: unknown) =>
        s.app.request(`/api/v1${path}`, {
            method,
            headers: { cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const withBearer = (token: string, method: string, path: string, body?: unknown) =>
        s.app.request(`/api/v1${path}`, {
            method,
            headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const newCode = async () =>
        CreatedPairingCode.parse(await (await withSession('POST', '/devices/pairing-codes')).json()).code;
    const pair = (code: string, name = 'phone', headers: Record<string, string> = {}) =>
        s.app.request('/api/v1/devices/pair', jsonBody({ code, name }, headers));
    const pairOk = async (name = 'phone') => DeviceTokens.parse(await (await pair(await newCode(), name)).json());
    const refresh = (refreshToken: string) => s.app.request('/api/v1/devices/token', jsonBody({ refreshToken }));
    return { session, withSession, withBearer, newCode, pair, pairOk, refresh };
}

describe('配对与令牌轮换', () => {
    it('配对码换令牌后能访问 API;refresh 轮换后旧 access 立即失效', async () => {
        const { withBearer, pairOk, refresh } = await boot();
        const first = await pairOk();
        expect((await withBearer(first.accessToken, 'GET', '/auth/me')).status).toBe(200);

        const res = await refresh(first.refreshToken);
        expect(res.status).toBe(200);
        const second = DeviceTokens.parse(await res.json());
        expect((await withBearer(first.accessToken, 'GET', '/auth/me')).status).toBe(401);
        expect((await withBearer(second.accessToken, 'GET', '/auth/me')).status).toBe(200);
    });

    it('配对码只能用一次;错误码、过期码都是 401,且达到上限后限速', async () => {
        const { newCode, pair } = await boot(new FailureLimiter(3, 60_000));
        const code = await newCode();
        expect((await pair(code)).status).toBe(201);
        expect((await pair(code)).status).toBe(401);

        const old = await newCode();
        s.conn.sqlite.prepare('UPDATE pairing_codes SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
        expect((await pair(old)).status).toBe(401);
        expect((await pair('AAAAA-AAAAA')).status).toBe(401);
        const limited = await pair('BBBBB-BBBBB');
        expect(limited.status).toBe(429);
        expect(limited.headers.get('Retry-After')).toBeTruthy();
    });

    it('重放已用过的 refresh 令牌会吊销整台设备并留下审计事件', async () => {
        const { withBearer, withSession, pairOk, refresh } = await boot();
        const first = await pairOk('stolen phone');
        const second = DeviceTokens.parse(await (await refresh(first.refreshToken)).json());

        expect((await refresh(first.refreshToken)).status).toBe(401);
        expect((await withBearer(second.accessToken, 'GET', '/auth/me')).status).toBe(401);
        expect((await refresh(second.refreshToken)).status).toBe(401);

        const events = (await (await withSession('GET', '/devices/events')).json()) as { items: unknown[] };
        const kinds = events.items.map((e) => DeviceEvent.parse(e).event);
        expect(kinds).toContain('replay-revoked');
        expect(kinds).toContain('paired');
    });
});

describe('设备管理', () => {
    it('列出、改名、吊销立即生效;设备能自己登出', async () => {
        const { withSession, withBearer, pairOk } = await boot();
        const a = await pairOk('a');
        const b = await pairOk('b');
        const list = (await (await withBearer(a.accessToken, 'GET', '/devices')).json()) as {
            items: { name: string }[];
        };
        expect(list.items.map((d) => d.name).sort()).toEqual(['a', 'b']);

        expect((await withSession('PATCH', `/devices/${a.device.id}`, { name: 'renamed' })).status).toBe(200);
        expect((await withSession('DELETE', `/devices/${a.device.id}`)).status).toBe(204);
        expect((await withBearer(a.accessToken, 'GET', '/auth/me')).status).toBe(401);

        expect((await withBearer(b.accessToken, 'DELETE', '/devices/self')).status).toBe(204);
        expect((await withBearer(b.accessToken, 'GET', '/auth/me')).status).toBe(401);
    });
});

describe('越权', () => {
    it('设备令牌不能创建配对码、创建或吊销访问令牌、管理设备、改两步验证', async () => {
        const { withBearer, pairOk } = await boot();
        const d = await pairOk();
        const other = await pairOk('other');
        const denied = [
            ['POST', '/devices/pairing-codes'],
            ['POST', '/tokens', { name: 'sneaky' }],
            ['DELETE', '/tokens/01ARZ3NDEKTSV4RRFFQ69G5FAV'],
            ['PATCH', `/devices/${other.device.id}`, { name: 'x' }],
            ['DELETE', `/devices/${other.device.id}`],
            ['GET', '/devices/events'],
            ['POST', '/auth/totp/setup', { password: TEST_PASSWORD }],
        ] as const;
        for (const [method, path, body] of denied) {
            const res = await withBearer(d.accessToken, method, path, body);
            expect(res.status, `${method} ${path}`).toBe(403);
        }
    });

    it('个人访问令牌也不能创建配对码;没有凭据的管理请求是 401', async () => {
        const { withSession, withBearer } = await boot();
        const pat = (await (await withSession('POST', '/tokens', { name: 'cli' })).json()) as { token: string };
        expect((await withBearer(pat.token, 'POST', '/devices/pairing-codes')).status).toBe(403);
        expect((await s.app.request('/api/v1/devices/pairing-codes', { method: 'POST' })).status).toBe(401);
        expect((await s.app.request('/api/v1/devices')).status).toBe(401);
    });

    it('库和日志里没有令牌或配对码明文', async () => {
        const { newCode, pair } = await boot();
        const code = await newCode();
        const tokens = DeviceTokens.parse(await (await pair(code)).json());
        const dump = JSON.stringify(
            ['pairing_codes', 'device_tokens', 'devices', 'device_events'].map((t) =>
                s.conn.sqlite.prepare(`SELECT * FROM ${t}`).all(),
            ),
        );
        for (const secret of [code, code.replace('-', ''), tokens.accessToken, tokens.refreshToken]) {
            expect(dump).not.toContain(secret);
            expect(s.logs.join('')).not.toContain(secret);
        }
    });
});
