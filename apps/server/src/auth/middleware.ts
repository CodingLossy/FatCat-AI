// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Repositories } from '@fatcat-ai/storage';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv, AuthContext } from '../env.js';
import { ApiError, unauthorized } from '../errors.js';
import { DEVICE_ACCESS_PREFIX, PAT_PREFIX, safeEqual, sha256 } from './crypto.js';

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
    // 邀请码建账户与重置码改密码(ADR 0053 第 2 节):凭一次性码,自己有限速
    'POST /api/v1/auth/invite/accept',
    'POST /api/v1/auth/password/reset',
    // 设备配对:凭一次性配对码 / refresh 令牌换令牌,自己有限速与审计(ADR 0045 第 1 节)
    'POST /api/v1/devices/pair',
    'POST /api/v1/devices/token',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthDeps {
    repos: Repositories;
    now: () => Date;
}

/**
 * 解析请求的凭据,不抛出 401:
 * - `Authorization: Bearer aip_pat_…` → 个人访问令牌,`aip_dev_…` → 设备 access 令牌(都不需要 CSRF);
 * - 否则读会话 Cookie;修改类请求还要求 X-CSRF-Token 与会话中的哈希一致,否则 403。
 */
export function resolveAuth(c: Context<AppEnv>, deps: AuthDeps): AuthContext | null {
    const header = c.req.header('Authorization');
    if (header !== undefined) {
        const match = /^Bearer\s+(\S+)$/i.exec(header);
        const token = match?.[1];
        if (token?.startsWith(DEVICE_ACCESS_PREFIX)) {
            const device = deps.repos.devices.findByAccess(sha256(token));
            if (!device) return null;
            const lastUsed = device.lastUsedAt ? Date.parse(device.lastUsedAt) : 0;
            if (deps.now().getTime() - lastUsed > TOUCH_INTERVAL_MS) deps.repos.devices.touch(device.deviceId);
            return { kind: 'device', ownerId: device.ownerId, deviceId: device.deviceId };
        }
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

/**
 * 只有管理员能做的操作(ADR 0053 第 4、6 节):不是管理员或账户已停用时回 403 `admin_required`。
 * 每次从库里读角色,不信客户端,也不缓存在会话里(降级立即生效)。
 */
export function requireAdmin(c: Context<AppEnv>, repos: Pick<Repositories, 'owners'>): string {
    const ownerId = requireOwner(c);
    const owner = repos.owners.get(ownerId);
    if (!owner) throw unauthorized();
    if (owner.role !== 'admin' || owner.disabledAt !== null) {
        throw new ApiError(403, 'admin_required', 'Forbidden', 'This needs an admin account.');
    }
    return ownerId;
}
