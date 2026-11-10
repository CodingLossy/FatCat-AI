// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute } from '@hono/zod-openapi';
import { AuthStatus, LoginRequest, LoginResponse, Me, SetupRequest } from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { dummyPasswordHash, hashPassword, randomToken, safeEqual, sha256, verifyPassword } from '../auth/crypto.js';
import { CSRF_COOKIE, requireOwner, SESSION_COOKIE, SESSION_TTL_MS } from '../auth/middleware.js';
import { FailureLimiter } from '../auth/rate-limit.js';
import type { CookieSecure } from '../config.js';
import type { AppEnv } from '../env.js';
import { ApiError, unauthorized } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

export interface AuthRouteDeps {
    repos: Repositories;
    now: () => Date;
    cookieSecure: CookieSecure;
    /** 一次性设置码;为 null 时只允许本机直连完成初始化。 */
    setupCode: string | null;
    /** 请求来源地址(TCP 对端),用于限速与本机判断。 */
    clientIp: (c: Context<AppEnv>) => string;
    loginLimiter?: FailureLimiter;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 本机直连:对端为回环地址,且没有经过反向代理(否则所有远程请求都会显示为本机)。 */
function isDirectLocal(c: Context<AppEnv>, ip: string): boolean {
    const proxied = ['x-forwarded-for', 'forwarded', 'x-real-ip'].some((h) => c.req.header(h) !== undefined);
    return LOOPBACK.has(ip) && !proxied;
}

function isSecureRequest(c: Context<AppEnv>, mode: CookieSecure): boolean {
    if (mode !== 'auto') return mode === 'always';
    return new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
}

const statusRoute = createRoute({
    method: 'get',
    path: '/auth/status',
    tags: ['auth'],
    summary: 'Whether the owner account exists and the caller is signed in',
    responses: { 200: json(AuthStatus, 'Status') },
});

const setupRoute = createRoute({
    method: 'post',
    path: '/auth/setup',
    tags: ['auth'],
    summary: 'Create the owner account on first start and sign in',
    request: { body: { content: { 'application/json': { schema: SetupRequest } }, required: true } },
    responses: {
        201: json(LoginResponse, 'Owner created and signed in'),
        400: problem('Invalid request'),
        403: problem('A setup code is required for non-local requests'),
        409: problem('The owner account already exists'),
    },
});

const loginRoute = createRoute({
    method: 'post',
    path: '/auth/login',
    tags: ['auth'],
    summary: 'Sign in with username and password',
    request: { body: { content: { 'application/json': { schema: LoginRequest } }, required: true } },
    responses: {
        200: json(LoginResponse, 'Signed in'),
        401: problem('Wrong username or password'),
        409: problem('The owner account does not exist yet'),
        429: problem('Too many failed attempts'),
    },
});

const logoutRoute = createRoute({
    method: 'post',
    path: '/auth/logout',
    tags: ['auth'],
    summary: 'Sign out the current browser session',
    responses: { 204: { description: 'Signed out' }, ...authErrors },
});

const meRoute = createRoute({
    method: 'get',
    path: '/auth/me',
    tags: ['auth'],
    summary: 'The signed-in owner',
    responses: { 200: json(Me, 'Owner'), ...authErrors },
});

export function authRoutes(deps: AuthRouteDeps) {
    const { repos, now } = deps;
    const limiter = deps.loginLimiter ?? new FailureLimiter(5, 60_000);

    /** 新建浏览器会话:Cookie 中放会话令牌(HttpOnly)与 CSRF 令牌(供前端读取后放进请求头)。 */
    function startSession(c: Context<AppEnv>, owner: { id: string; username: string }) {
        const sessionToken = randomToken();
        const csrfToken = randomToken();
        const expiresAt = new Date(now().getTime() + SESSION_TTL_MS);
        repos.authSessions.create({
            idHash: sha256(sessionToken),
            ownerId: owner.id,
            csrfHash: sha256(csrfToken),
            expiresAt,
        });
        const base = {
            path: '/',
            sameSite: 'Strict' as const,
            secure: isSecureRequest(c, deps.cookieSecure),
            maxAge: Math.floor(SESSION_TTL_MS / 1000),
        };
        setCookie(c, SESSION_COOKIE, sessionToken, { ...base, httpOnly: true });
        setCookie(c, CSRF_COOKIE, csrfToken, { ...base, httpOnly: false });
        return { owner: { id: owner.id, username: owner.username }, csrfToken, expiresAt: expiresAt.toISOString() };
    }

    return router()
        .openapi(statusRoute, (c) => {
            // 鉴权中间件对公开端点也会解析凭据
            return c.json({ initialized: repos.owners.count() > 0, authenticated: c.get('auth') !== null }, 200);
        })
        .openapi(setupRoute, async (c) => {
            if (repos.owners.count() > 0) {
                throw new ApiError(409, 'already_initialized', 'Conflict', 'The owner account already exists.');
            }
            const body = c.req.valid('json');
            const local = isDirectLocal(c, deps.clientIp(c));
            const codeOk =
                deps.setupCode !== null && body.setupCode !== undefined && safeEqual(body.setupCode, deps.setupCode);
            if (!local && !codeOk) {
                throw new ApiError(
                    403,
                    'forbidden',
                    'Forbidden',
                    'Setup from a non-local address requires the one-time setup code printed in the server log.',
                );
            }
            let owner;
            try {
                owner = repos.owners.create({
                    username: body.username,
                    passwordHash: await hashPassword(body.password),
                });
            } catch {
                // 并发初始化时单行触发器会拒绝第二个请求
                throw new ApiError(409, 'already_initialized', 'Conflict', 'The owner account already exists.');
            }
            c.get('logger').info({ ownerId: owner.id }, 'owner account created');
            return c.json(startSession(c, owner), 201);
        })
        .openapi(loginRoute, async (c) => {
            const ip = deps.clientIp(c);
            const wait = limiter.retryAfter(ip);
            if (wait > 0) {
                throw new ApiError(429, 'rate_limited', 'Too Many Requests', 'Too many failed sign-in attempts.', {
                    headers: { 'Retry-After': String(wait) },
                });
            }
            if (repos.owners.count() === 0) {
                throw new ApiError(409, 'not_initialized', 'Conflict', 'Create the owner account first.');
            }
            const body = c.req.valid('json');
            const owner = repos.owners.getByUsername(body.username);
            const ok = await verifyPassword(body.password, owner?.passwordHash ?? (await dummyPasswordHash()));
            if (!owner || !ok) {
                limiter.recordFailure(ip);
                c.get('logger').warn({ ip }, 'sign-in failed');
                throw new ApiError(401, 'unauthorized', 'Unauthorized', 'Wrong username or password.');
            }
            limiter.reset(ip);
            repos.authSessions.deleteExpired();
            return c.json(startSession(c, owner), 200);
        })
        .openapi(logoutRoute, (c) => {
            const auth = c.get('auth');
            if (!auth) throw unauthorized();
            if (auth.kind === 'session') repos.authSessions.delete(auth.sessionHash);
            deleteCookie(c, SESSION_COOKIE, { path: '/' });
            deleteCookie(c, CSRF_COOKIE, { path: '/' });
            return c.body(null, 204);
        })
        .openapi(meRoute, (c) => {
            const owner = repos.owners.get(requireOwner(c));
            if (!owner) throw unauthorized();
            return c.json({ id: owner.id, username: owner.username, createdAt: owner.createdAt }, 200);
        });
}
