// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Repositories } from '@fatcat-ai/storage';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv, AuthContext } from '../env.js';
import { ApiError, unauthorized } from '../errors.js';
import { PAT_PREFIX, safeEqual, sha256 } from './crypto.js';

export const SESSION_COOKIE = 'aip_session';
export const CSRF_COOKIE = 'aip_csrf';
export const CSRF_HEADER = 'X-CSRF-Token';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 滑动续期与 lastUsedAt 的写入间隔,避免每个请求都写库。 */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** 不需要鉴权的端点(ADR 0004 第 2 节)。setup 自身另有限制。 */
export const PUBLIC_ENDPOINTS: ReadonlySet<string> = new Set([
    'GET /api/v1/meta',
    'GET /api/v1/auth/status',
    'POST /api/v1/auth/login',
    'POST /api/v1/auth/login/totp',
    'POST /api/v1/auth/setup',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthDeps {
    repos: Repositories;
    now: () => Date;
}

/**
 * 解析请求的凭据,不抛出 401:
 * - `Authorization: Bearer aip_pat_…` → 个人访问令牌(不需要 CSRF);
 * - 否则读会话 Cookie;修改类请求还要求 X-CSRF-Token 与会话中的哈希一致,否则 403。
 */
export function resolveAuth(c: Context<AppEnv>, deps: AuthDeps): AuthContext | null {
    const header = c.req.header('Authorization');
    if (header !== undefined) {
        const match = /^Bearer\s+(\S+)$/i.exec(header);
        const token = match?.[1];
        if (!token?.startsWith(PAT_PREFIX)) return null;
        const record = deps.repos.accessTokens.findUsable(sha256(token));
        if (!record) return null;
        const lastUsed = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
        if (deps.now().getTime() - lastUsed > TOUCH_INTERVAL_MS) deps.repos.accessTokens.touch(record.id);
        return { kind: 'token', ownerId: record.ownerId, tokenId: record.id };
    }

    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie) return null;
    const sessionHash = sha256(cookie);
    const session = deps.repos.authSessions.getValid(sessionHash);
    if (!session) return null;

    if (!SAFE_METHODS.has(c.req.method)) {
        const csrf = c.req.header(CSRF_HEADER);
        if (!csrf || !safeEqual(sha256(csrf), session.csrfHash)) {
            throw new ApiError(403, 'csrf_failed', 'Forbidden', `A valid ${CSRF_HEADER} header is required.`);
        }
    }

    const nowMs = deps.now().getTime();
    if (nowMs - Date.parse(session.lastSeenAt) > TOUCH_INTERVAL_MS) {
        deps.repos.authSessions.touch(sessionHash, new Date(nowMs + SESSION_TTL_MS));
    }
    return { kind: 'session', ownerId: session.ownerId, sessionHash };
}

/** /api/v1 下除公开端点外一律要求鉴权;公开端点也解析凭据,供 /auth/status 等使用。 */
export function authMiddleware(deps: AuthDeps): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const isPublic = PUBLIC_ENDPOINTS.has(`${c.req.method} ${c.req.path}`);
        let auth: AuthContext | null = null;
        try {
            auth = resolveAuth(c, deps);
        } catch (error) {
            // 公开端点(如 login)不因旧会话的 CSRF 问题被拒绝
            if (!isPublic) throw error;
        }
        if (!auth && !isPublic) throw unauthorized();
        c.set('auth', auth);
        await next();
    };
}

/** 在已鉴权的路由里取 ownerId。 */
export function requireOwner(c: Context<AppEnv>): string {
    const auth = c.get('auth');
    if (!auth) throw unauthorized();
    return auth.ownerId;
}
