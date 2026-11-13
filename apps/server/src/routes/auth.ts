// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute } from '@hono/zod-openapi';
import {
    AuthStatus,
    LoginChallenge,
    LoginRequest,
    LoginResponse,
    Me,
    SetupRequest,
    TotpConfirmRequest,
    TotpEnableRequest,
    TotpLoginRequest,
    TotpRecoveryCodes,
    TotpSetup,
    TotpSetupRequest,
    TotpStatus,
} from '@fatcat-ai/shared';
import type { MasterKeyResolver } from '@fatcat-ai/providers';
import type { Repositories } from '@fatcat-ai/storage';
import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { dummyPasswordHash, hashPassword, randomToken, safeEqual, sha256, verifyPassword } from '../auth/crypto.js';
import { CSRF_COOKIE, requireOwner, SESSION_COOKIE, SESSION_TTL_MS } from '../auth/middleware.js';
import { LoginChallenges } from '../auth/login-challenge.js';
import { FailureLimiter } from '../auth/rate-limit.js';
import { TotpService } from '../auth/totp-service.js';
import { generateTotpSecret, otpauthUri } from '../auth/totp.js';
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
    /** 第二因素的失败限速(按用户名与按 IP 分别计数,ADR 0027 第 5 节);不给时每分钟 5 次。 */
    totpLimiter?: FailureLimiter;
    /** 主密钥来源(ADR 0026);TOTP 共享密钥用它加密入库。不可用时启用与验证都失败。 */
    masterKey?: MasterKeyResolver | undefined;
    /** 登录临时凭证(内存);测试可注入。 */
    challenges?: LoginChallenges;
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
        202: json(
            LoginChallenge,
            'The password is correct and TOTP is enabled: no session yet; send the code to POST /auth/login/totp',
        ),
        401: problem('Wrong username or password'),
        409: problem('The owner account does not exist yet'),
        429: problem('Too many failed attempts'),
    },
});

const loginTotpRoute = createRoute({
    method: 'post',
    path: '/auth/login/totp',
    tags: ['auth'],
    summary: 'Finish a sign-in that needs a TOTP code or a recovery code',
    request: { body: { content: { 'application/json': { schema: TotpLoginRequest } }, required: true } },
    responses: {
        200: json(LoginResponse, 'Signed in'),
        401: problem('Wrong code, or the sign-in challenge expired or was used up'),
        429: problem('Too many failed attempts'),
        503: problem('The master key is unavailable'),
    },
});

const totpStatusRoute = createRoute({
    method: 'get',
    path: '/auth/totp',
    tags: ['auth'],
    summary: 'Whether TOTP is enabled and how many recovery codes are left',
    responses: { 200: json(TotpStatus, 'Status'), ...authErrors },
});

const totpSetupRoute = createRoute({
    method: 'post',
    path: '/auth/totp/setup',
    tags: ['auth'],
    summary: 'Generate a pending TOTP secret (needs the password); it takes effect after enable',
    request: { body: { content: { 'application/json': { schema: TotpSetupRequest } }, required: true } },
    responses: {
        200: json(TotpSetup, 'The secret and otpauth URI, shown only in this response'),
        403: problem('Wrong password, or a token was used'),
        409: problem('TOTP is already enabled'),
        429: problem('Too many failed attempts'),
        503: problem('The master key is unavailable'),
    },
});

const totpEnableRoute = createRoute({
    method: 'post',
    path: '/auth/totp/enable',
    tags: ['auth'],
    summary: 'Turn TOTP on (password and a code); other sessions are revoked',
    request: { body: { content: { 'application/json': { schema: TotpEnableRequest } }, required: true } },
    responses: {
        200: json(TotpRecoveryCodes, 'Recovery codes, shown only in this response'),
        403: problem('Wrong password or code, or a token was used'),
        409: problem('Run setup first, or TOTP is already enabled'),
        429: problem('Too many failed attempts'),
        503: problem('The master key is unavailable'),
    },
});

const totpDisableRoute = createRoute({
    method: 'post',
    path: '/auth/totp/disable',
    tags: ['auth'],
    summary: 'Turn TOTP off (password and a code or recovery code); other sessions are revoked',
    request: { body: { content: { 'application/json': { schema: TotpConfirmRequest } }, required: true } },
    responses: {
        204: { description: 'TOTP is off' },
        403: problem('Wrong password or code, or a token was used'),
        409: problem('TOTP is not enabled'),
        429: problem('Too many failed attempts'),
        503: problem('The master key is unavailable'),
    },
});

const totpRecoveryRoute = createRoute({
    method: 'post',
    path: '/auth/totp/recovery-codes',
    tags: ['auth'],
    summary: 'Replace the recovery codes (password and a code or recovery code); the old ones stop working',
    request: { body: { content: { 'application/json': { schema: TotpConfirmRequest } }, required: true } },
    responses: {
        200: json(TotpRecoveryCodes, 'New recovery codes, shown only in this response'),
        403: problem('Wrong password or code, or a token was used'),
        409: problem('TOTP is not enabled'),
        429: problem('Too many failed attempts'),
        503: problem('The master key is unavailable'),
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
    // 第二因素:按用户名与按 IP 分别计数,任一超限即锁定,锁定期间连正确的验证码也拒绝
    const totpLimiter = deps.totpLimiter ?? new FailureLimiter(5, 60_000);
    const challenges = deps.challenges ?? new LoginChallenges(now);
    const totp = new TotpService({ repos, masterKey: deps.masterKey, now });

    const ipKey = (ip: string) => `ip:${ip}`;
    const userKey = (username: string) => `user:${username.toLowerCase()}`;
    const lockedFor = (keys: string[]) => Math.max(...keys.map((k) => totpLimiter.retryAfter(k)));
    function guardTotp(keys: string[]): void {
        const wait = lockedFor(keys);
        if (wait > 0) {
            throw new ApiError(429, 'rate_limited', 'Too Many Requests', 'Too many failed verification attempts.', {
                headers: { 'Retry-After': String(wait) },
            });
        }
    }
    const failTotp = (keys: string[]) => keys.forEach((k) => totpLimiter.recordFailure(k));
    const clearTotp = (keys: string[]) => keys.forEach((k) => totpLimiter.reset(k));
    // 登录第二步的所有失败(临时凭证无效、过期、用尽、验证码错)对外是同一个错误
    const loginStepFailed = () =>
        new ApiError(401, 'unauthorized', 'Unauthorized', 'Sign-in failed. Check the code, or sign in again.');
    const badCredentials = () => new ApiError(403, 'forbidden', 'Forbidden', 'Wrong password or verification code.');

    /** /auth/totp/* 只给浏览器会话用;个人访问令牌一律拒绝。 */
    function requireSession(c: Context<AppEnv>) {
        const auth = c.get('auth');
        if (!auth) throw unauthorized();
        if (auth.kind !== 'session') {
            throw new ApiError(
                403,
                'forbidden',
                'Forbidden',
                'Personal access tokens cannot manage two-factor settings.',
            );
        }
        return auth;
    }

    /** 已登录会话上的敏感操作:先看锁定,再验密码(错了计一次失败)。返回主人与限流用的键。 */
    async function confirmPassword(c: Context<AppEnv>, password: string) {
        c.header('Cache-Control', 'no-store');
        const auth = requireSession(c);
        const owner = repos.owners.get(auth.ownerId);
        if (!owner) throw unauthorized();
        const keys = [ipKey(deps.clientIp(c)), userKey(owner.username)];
        guardTotp(keys);
        if (!(await verifyPassword(password, owner.passwordHash))) {
            failTotp(keys);
            c.get('logger').warn({ ownerId: owner.id }, 'two-factor confirmation failed');
            throw badCredentials();
        }
        return { auth, owner, keys };
    }

    /** 新建浏览器会话:Cookie 中放会话令牌(HttpOnly)与 CSRF 令牌(供前端读取后放进请求头)。 */
    function startSession(c: Context<AppEnv>, owner: { id: string; username: string }, secondFactor = false) {
        const sessionToken = randomToken();
        const csrfToken = randomToken();
        const expiresAt = new Date(now().getTime() + SESSION_TTL_MS);
        repos.authSessions.create({
            idHash: sha256(sessionToken),
            ownerId: owner.id,
            csrfHash: sha256(csrfToken),
            expiresAt,
            ...(secondFactor ? { secondFactor: true } : {}),
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
            // 已启用 TOTP:不发会话,只发 5 分钟的一次性临时凭证(ADR 0027 第 2 节)
            if (repos.totp.get(owner.id)?.enabled) {
                const challenge = challenges.issue(owner.id);
                c.header('Cache-Control', 'no-store');
                return c.json(
                    {
                        totpRequired: true as const,
                        challengeToken: challenge.token,
                        expiresAt: challenge.expiresAt.toISOString(),
                    },
                    202,
                );
            }
            return c.json(startSession(c, owner), 200);
        })
        .openapi(loginTotpRoute, (c) => {
            const body = c.req.valid('json');
            const ip = ipKey(deps.clientIp(c));
            guardTotp([ip]);
            const pending = challenges.lookup(body.challengeToken);
            const owner = pending ? repos.owners.get(pending.ownerId) : null;
            if (!pending || !owner) {
                totpLimiter.recordFailure(ip);
                throw loginStepFailed();
            }
            const keys = [ip, userKey(owner.username)];
            guardTotp(keys);
            const credential = repos.totp.get(owner.id);
            if (!credential?.enabled) {
                challenges.consume(body.challengeToken);
                failTotp(keys);
                throw loginStepFailed();
            }
            // 校验与核销之间没有 await:同一个验证码的并发提交只有一个能通过
            if (!totp.checkSecondFactor(credential, body)) {
                challenges.fail(body.challengeToken);
                failTotp(keys);
                c.get('logger').warn({ ownerId: owner.id }, 'second factor failed');
                throw loginStepFailed();
            }
            challenges.consume(body.challengeToken);
            clearTotp(keys);
            repos.authSessions.deleteExpired();
            return c.json(startSession(c, owner, true), 200);
        })
        .openapi(totpStatusRoute, (c) => {
            const auth = requireSession(c);
            const credential = repos.totp.get(auth.ownerId);
            const enabled = credential?.enabled === true;
            return c.json(
                {
                    enabled,
                    enabledAt: enabled ? (credential?.enabledAt ?? null) : null,
                    recoveryCodesRemaining: enabled ? repos.totp.recoveryCodesRemaining(auth.ownerId) : 0,
                },
                200,
            );
        })
        .openapi(totpSetupRoute, async (c) => {
            const { owner, keys } = await confirmPassword(c, c.req.valid('json').password);
            if (repos.totp.get(owner.id)?.enabled) {
                throw new ApiError(409, 'conflict', 'Conflict', 'TOTP is already enabled. Turn it off first.');
            }
            const secret = generateTotpSecret();
            if (!repos.totp.saveSetup(owner.id, totp.encryptNewSecret(secret))) {
                throw new ApiError(409, 'conflict', 'Conflict', 'TOTP is already enabled. Turn it off first.');
            }
            clearTotp(keys);
            return c.json({ otpauthUri: otpauthUri(owner.username, secret), secret }, 200);
        })
        .openapi(totpEnableRoute, async (c) => {
            const body = c.req.valid('json');
            const { auth, owner, keys } = await confirmPassword(c, body.password);
            const credential = repos.totp.get(owner.id);
            if (!credential || credential.enabled) {
                throw new ApiError(409, 'conflict', 'Conflict', 'Run setup first, or TOTP is already enabled.');
            }
            const step = totp.stepFor(credential, body.code);
            if (step === null) {
                failTotp(keys);
                throw badCredentials();
            }
            const codes = totp.newRecoveryCodes();
            const enabled = repos.totp.enable({
                ownerId: owner.id,
                step,
                codes: codes.hashes,
                keepSessionHash: auth.sessionHash,
            });
            if (!enabled)
                throw new ApiError(409, 'conflict', 'Conflict', 'Run setup first, or TOTP is already enabled.');
            clearTotp(keys);
            c.get('logger').info({ ownerId: owner.id }, 'TOTP enabled; other sessions revoked');
            return c.json({ recoveryCodes: codes.plain }, 200);
        })
        .openapi(totpDisableRoute, async (c) => {
            const body = c.req.valid('json');
            const { auth, owner, keys } = await confirmPassword(c, body.password);
            const credential = repos.totp.get(owner.id);
            if (!credential?.enabled) throw new ApiError(409, 'conflict', 'Conflict', 'TOTP is not enabled.');
            if (!totp.checkSecondFactor(credential, body)) {
                failTotp(keys);
                throw badCredentials();
            }
            repos.totp.disable(owner.id, auth.sessionHash);
            clearTotp(keys);
            c.get('logger').info({ ownerId: owner.id }, 'TOTP disabled; other sessions revoked');
            return c.body(null, 204);
        })
        .openapi(totpRecoveryRoute, async (c) => {
            const body = c.req.valid('json');
            const { owner, keys } = await confirmPassword(c, body.password);
            const credential = repos.totp.get(owner.id);
            if (!credential?.enabled) throw new ApiError(409, 'conflict', 'Conflict', 'TOTP is not enabled.');
            if (!totp.checkSecondFactor(credential, body)) {
                failTotp(keys);
                throw badCredentials();
            }
            const codes = totp.newRecoveryCodes();
            repos.totp.replaceRecoveryCodes(owner.id, codes.hashes);
            clearTotp(keys);
            return c.json({ recoveryCodes: codes.plain }, 200);
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
