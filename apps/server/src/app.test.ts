// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaResponseSchema, ProblemDetails } from '@ai-personal/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_ENDPOINTS } from './auth/middleware.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(() => s?.cleanup());

const ULID = '01JC0000000000000000000000';

async function signedIn(server: TestServer) {
    const res = await server.app.request(
        '/api/v1/auth/setup',
        jsonBody({ username: 'owner', password: TEST_PASSWORD }),
    );
    expect(res.status).toBe(201);
    return sessionFrom(res);
}

describe('基础端点', () => {
    it('GET /healthz 返回 200,并带版本头与请求 id', async () => {
        s = await createTestServer();
        const res = await s.app.request('/healthz', { headers: { 'X-Request-Id': 'req-1' } });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });
        expect(res.headers.get('X-AIP-Server-Version')).toBeTruthy();
        expect(res.headers.get('X-Request-Id')).toBe('req-1');
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('GET /api/v1/meta 公开,返回许可证与源码地址', async () => {
        s = await createTestServer();
        const res = await s.app.request('/api/v1/meta');
        expect(res.status).toBe(200);
        const meta = MetaResponseSchema.parse(await res.json());
        expect(meta.license).toBe('AGPL-3.0-only');
        expect(meta.sourceUrl).toBe('https://github.com/CodingLossy/AI-Personal');
    });

    it('/api 下未知路径:未登录 401,已登录 404,均为 problem+json', async () => {
        s = await createTestServer();
        const anon = await s.app.request('/api/v1/nope');
        expect(anon.status).toBe(401);
        expect(anon.headers.get('content-type')).toContain('application/problem+json');
        const { cookie } = await signedIn(s);
        const res = await s.app.request('/api/v1/nope', { headers: { cookie } });
        expect(res.status).toBe(404);
        expect(ProblemDetails.parse(await res.json()).code).toBe('not_found');
    });

    it('配置 webDir 时托管 Web UI', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'aip-web-'));
        writeFileSync(join(dir, 'index.html'), '<!doctype html><title>AI-Personal</title>');
        s = await createTestServer({ webDir: dir });
        const page = await s.app.request('/some/route');
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('AI-Personal');
    });

    it('请求体超过 2MB 返回 413', async () => {
        s = await createTestServer();
        const res = await s.app.request('/api/v1/auth/login', jsonBody({ username: 'x'.repeat(3 * 1024 * 1024) }));
        expect(res.status).toBe(413);
    });
});

describe('未登录访问一律 401(遍历全部路由)', () => {
    it('除公开端点外的每个 /api/v1 路由都返回 401', async () => {
        s = await createTestServer();
        const routes = s.app.routes
            .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/v1/'))
            .map((r) => ({ method: r.method, path: r.path.replace(/:[A-Za-z]+/g, ULID) }));
        const protectedRoutes = routes.filter((r) => !PUBLIC_ENDPOINTS.has(`${r.method} ${r.path}`));
        expect(protectedRoutes.length).toBeGreaterThanOrEqual(5);
        expect(protectedRoutes.map((r) => r.path)).toContain('/api/v1/openapi.json');

        for (const r of protectedRoutes) {
            const res = await s.app.request(r.path, {
                method: r.method,
                headers: { 'content-type': 'application/json' },
                ...(r.method === 'GET' ? {} : { body: '{}' }),
            });
            expect(res.status, `${r.method} ${r.path}`).toBe(401);
            expect(ProblemDetails.parse(await res.json()).code).toBe('unauthorized');
        }
    });

    it('格式错误或伪造的 Bearer 令牌返回 401', async () => {
        s = await createTestServer();
        for (const auth of ['Bearer nope', 'Bearer aip_pat_forged', 'Basic abc', 'Bearer']) {
            const res = await s.app.request('/api/v1/auth/me', { headers: { Authorization: auth } });
            expect(res.status, auth).toBe(401);
        }
    });
});

describe('初始化与登录', () => {
    it('本机直连无需设置码;初始化后状态变化,不能重复初始化', async () => {
        s = await createTestServer();
        const before = await s.app.request('/api/v1/auth/status');
        expect(await before.json()).toEqual({ initialized: false, authenticated: false });

        const { cookie, setCookies } = await signedIn(s);
        const session = setCookies.find((c) => c.startsWith('aip_session='))!;
        expect(session).toMatch(/HttpOnly/i);
        expect(session).toMatch(/SameSite=Strict/i);
        expect(session).not.toMatch(/Secure/i);
        expect(setCookies.find((c) => c.startsWith('aip_csrf='))).not.toMatch(/HttpOnly/i);

        const after = await s.app.request('/api/v1/auth/status', { headers: { cookie } });
        expect(await after.json()).toEqual({ initialized: true, authenticated: true });

        const again = await s.app.request(
            '/api/v1/auth/setup',
            jsonBody({ username: 'owner2', password: TEST_PASSWORD }),
        );
        expect(again.status).toBe(409);
        expect(ProblemDetails.parse(await again.json()).code).toBe('already_initialized');
    });

    it('非本机或经过代理的请求需要正确的设置码', async () => {
        s = await createTestServer();
        const body = { username: 'owner', password: TEST_PASSWORD };
        const remote = { 'x-test-ip': '203.0.113.9' };
        expect((await s.app.request('/api/v1/auth/setup', jsonBody(body, remote))).status).toBe(403);
        expect(
            (await s.app.request('/api/v1/auth/setup', jsonBody({ ...body, setupCode: 'wrong-code-1' }, remote)))
                .status,
        ).toBe(403);
        // 反向代理在本机时,对端是 127.0.0.1,但带有转发头
        expect(
            (await s.app.request('/api/v1/auth/setup', jsonBody(body, { 'x-forwarded-for': '203.0.113.9' }))).status,
        ).toBe(403);
        const ok = await s.app.request(
            '/api/v1/auth/setup',
            jsonBody({ ...body, setupCode: 'setup-code-123456' }, remote),
        );
        expect(ok.status).toBe(201);
    });

    it('没有设置码配置时,非本机请求一律拒绝', async () => {
        s = await createTestServer({ setupCode: null });
        const res = await s.app.request(
            '/api/v1/auth/setup',
            jsonBody(
                { username: 'owner', password: TEST_PASSWORD, setupCode: 'anything-1' },
                { 'x-test-ip': '10.0.0.2' },
            ),
        );
        expect(res.status).toBe(403);
    });

    it('登录成功返回会话;密码错误 401;cookieSecure=always 时 Cookie 带 Secure', async () => {
        s = await createTestServer({ cookieSecure: 'always' });
        await signedIn(s);
        const wrong = await s.app.request(
            '/api/v1/auth/login',
            jsonBody({ username: 'owner', password: 'wrong password!' }),
        );
        expect(wrong.status).toBe(401);
        const unknown = await s.app.request(
            '/api/v1/auth/login',
            jsonBody({ username: 'nobody', password: TEST_PASSWORD }),
        );
        expect(unknown.status).toBe(401);

        const ok = await s.app.request('/api/v1/auth/login', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as { owner: { username: string }; csrfToken: string };
        expect(body.owner.username).toBe('owner');
        const { csrf, setCookies } = sessionFrom(ok);
        expect(body.csrfToken).toBe(csrf);
        expect(setCookies.every((c) => /;\s*Secure/i.test(c))).toBe(true);
    });

    it('同一来源连续失败 5 次后返回 429,其他来源不受影响', async () => {
        s = await createTestServer();
        await signedIn(s);
        const attempt = (password: string, ip: string) =>
            s.app.request('/api/v1/auth/login', jsonBody({ username: 'owner', password }, { 'x-test-ip': ip }));
        for (let i = 0; i < 5; i++) expect((await attempt('wrong password!', '198.51.100.1')).status).toBe(401);
        const limited = await attempt(TEST_PASSWORD, '198.51.100.1');
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect((await attempt(TEST_PASSWORD, '198.51.100.2')).status).toBe(200);
    });

    it('参数校验失败返回 400 与字段路径', async () => {
        s = await createTestServer();
        const res = await s.app.request('/api/v1/auth/login', jsonBody({ username: 'owner', password: 'short' }));
        expect(res.status).toBe(400);
        const p = ProblemDetails.parse(await res.json());
        expect(p.code).toBe('validation_failed');
        expect(p.issues?.[0]?.path).toEqual(['password']);
    });
});

describe('会话与 CSRF', () => {
    it('Cookie 会话的修改类请求必须带正确的 X-CSRF-Token', async () => {
        s = await createTestServer();
        const { cookie, csrf } = await signedIn(s);
        const create = (headers: Record<string, string>) =>
            s.app.request('/api/v1/tokens', jsonBody({ name: 'cli' }, { cookie, ...headers }));

        const missing = await create({});
        expect(missing.status).toBe(403);
        expect(ProblemDetails.parse(await missing.json()).code).toBe('csrf_failed');
        expect((await create({ 'X-CSRF-Token': 'forged' })).status).toBe(403);
        expect((await create({ 'X-CSRF-Token': csrf })).status).toBe(201);

        // GET 不需要 CSRF
        expect((await s.app.request('/api/v1/auth/me', { headers: { cookie } })).status).toBe(200);
    });

    it('登出后会话失效', async () => {
        s = await createTestServer();
        const { cookie, csrf } = await signedIn(s);
        const out = await s.app.request('/api/v1/auth/logout', {
            method: 'POST',
            headers: { cookie, 'X-CSRF-Token': csrf },
        });
        expect(out.status).toBe(204);
        expect((await s.app.request('/api/v1/auth/me', { headers: { cookie } })).status).toBe(401);
    });
});

describe('个人访问令牌', () => {
    it('创建、使用(无需 CSRF)、列表不含明文、吊销后失效', async () => {
        s = await createTestServer();
        const { cookie, csrf } = await signedIn(s);
        const created = await s.app.request(
            '/api/v1/tokens',
            jsonBody({ name: 'cli', expiresInDays: 30 }, { cookie, 'X-CSRF-Token': csrf }),
        );
        expect(created.status).toBe(201);
        const { id, token, expiresAt } = (await created.json()) as { id: string; token: string; expiresAt: string };
        expect(token).toMatch(/^aip_pat_[A-Za-z0-9_-]{43}$/);
        expect(expiresAt).not.toBeNull();

        const bearer = { Authorization: `Bearer ${token}` };
        const me = await s.app.request('/api/v1/auth/me', { headers: bearer });
        expect(me.status).toBe(200);
        expect(((await me.json()) as { username: string }).username).toBe('owner');
        expect((await s.app.request('/api/v1/tokens', jsonBody({ name: 'second' }, bearer))).status).toBe(201);

        const list = await s.app.request('/api/v1/tokens', { headers: bearer });
        const listText = await list.text();
        expect(listText).not.toContain(token);
        expect(listText).not.toContain('tokenHash');

        expect((await s.app.request(`/api/v1/tokens/${id}`, { method: 'DELETE', headers: bearer })).status).toBe(204);
        expect((await s.app.request('/api/v1/auth/me', { headers: bearer })).status).toBe(401);
        expect(
            (
                await s.app.request(`/api/v1/tokens/${ULID}`, {
                    method: 'DELETE',
                    headers: { cookie, 'X-CSRF-Token': csrf },
                })
            ).status,
        ).toBe(404);
    });

    it('OpenAPI 文档需要鉴权,登录后可读取', async () => {
        s = await createTestServer();
        const { cookie } = await signedIn(s);
        const res = await s.app.request('/api/v1/openapi.json', { headers: { cookie } });
        expect(res.status).toBe(200);
        const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
        expect(doc.openapi).toBe('3.1.0');
        expect(Object.keys(doc.paths)).toEqual(
            expect.arrayContaining(['/api/v1/meta', '/api/v1/auth/login', '/api/v1/tokens', '/api/v1/tokens/{id}']),
        );
    });
});

describe('日志不含凭据', () => {
    it('完整流程中密码、会话令牌、CSRF 令牌与访问令牌都不出现在日志里', async () => {
        s = await createTestServer();
        const { cookie, csrf } = await signedIn(s);
        await s.app.request('/api/v1/auth/login', jsonBody({ username: 'owner', password: 'wrong password!' }));
        const created = await s.app.request(
            '/api/v1/tokens',
            jsonBody({ name: 'cli' }, { cookie, 'X-CSRF-Token': csrf }),
        );
        const { token } = (await created.json()) as { token: string };
        await s.app.request('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });

        const all = s.logs.join('');
        expect(s.logs.length).toBeGreaterThan(3);
        const sessionToken = cookie
            .split('; ')
            .find((p) => p.startsWith('aip_session='))!
            .split('=')[1]!;
        for (const secret of [TEST_PASSWORD, 'wrong password!', sessionToken, csrf, token]) {
            expect(all).not.toContain(secret);
        }
        for (const line of s.logs) expect(() => JSON.parse(line)).not.toThrow();
    });
});
