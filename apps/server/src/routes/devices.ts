// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute, z } from '@hono/zod-openapi';
import {
    CreatedPairingCode,
    Device,
    DeviceEvent,
    DeviceTokens,
    Id,
    PairDeviceRequest,
    RefreshDeviceTokenRequest,
    RenameDeviceRequest,
    pageOf,
} from '@fatcat-ai/shared';
import type { DeviceTokenHashes, Repositories } from '@fatcat-ai/storage';
import type { Context } from 'hono';
import {
    newDeviceAccessToken,
    newDeviceRefreshToken,
    newPairingCode,
    normalizePairingCode,
    sha256,
} from '../auth/crypto.js';
import type { AttemptLimiter } from '../auth/rate-limit.js';
import { FailureLimiter } from '../auth/rate-limit.js';
import { requireOwner } from '../auth/middleware.js';
import type { AppEnv } from '../env.js';
import { ApiError, notFound, unauthorized } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const idParam = z.object({ id: Id });

const createCodeRoute = createRoute({
    method: 'post',
    path: '/devices/pairing-codes',
    tags: ['devices'],
    summary: 'Create a one-time pairing code (5 minutes, single use); needs a signed-in browser session',
    responses: { 201: json(CreatedPairingCode, 'Created'), 429: problem('Too many open codes'), ...authErrors },
});

const pairRoute = createRoute({
    method: 'post',
    path: '/devices/pair',
    tags: ['devices'],
    summary: 'Exchange a pairing code for device tokens (public, rate limited)',
    request: { body: { content: { 'application/json': { schema: PairDeviceRequest } }, required: true } },
    responses: {
        201: json(DeviceTokens, 'Paired'),
        401: problem('Invalid, used or expired code'),
        429: problem('Too many failed attempts'),
    },
});

const refreshRoute = createRoute({
    method: 'post',
    path: '/devices/token',
    tags: ['devices'],
    summary: 'Exchange a refresh token for a new token pair (public); reusing an old refresh token revokes the device',
    request: { body: { content: { 'application/json': { schema: RefreshDeviceTokenRequest } }, required: true } },
    responses: {
        200: json(DeviceTokens, 'New tokens'),
        401: problem('Invalid, expired or reused refresh token'),
        429: problem('Too many failed attempts'),
    },
});

const listRoute = createRoute({
    method: 'get',
    path: '/devices',
    tags: ['devices'],
    summary: 'List paired devices that are not revoked',
    responses: { 200: json(pageOf(Device), 'Devices'), ...authErrors },
});

const eventsRoute = createRoute({
    method: 'get',
    path: '/devices/events',
    tags: ['devices'],
    summary: 'Pairing and device audit events, newest first; needs a browser session',
    responses: { 200: json(pageOf(DeviceEvent), 'Events'), ...authErrors },
});

const selfRevokeRoute = createRoute({
    method: 'delete',
    path: '/devices/self',
    tags: ['devices'],
    summary: 'Sign this device out (revoke it); only for device tokens',
    responses: { 204: { description: 'Revoked' }, ...authErrors },
});

const renameRoute = createRoute({
    method: 'patch',
    path: '/devices/{id}',
    tags: ['devices'],
    summary: 'Rename a device; needs a browser session',
    request: {
        params: idParam,
        body: { content: { 'application/json': { schema: RenameDeviceRequest } }, required: true },
    },
    responses: { 200: json(Device, 'Renamed'), 404: problem('Device not found'), ...authErrors },
});

const revokeRoute = createRoute({
    method: 'delete',
    path: '/devices/{id}',
    tags: ['devices'],
    summary: 'Revoke a device; takes effect immediately; needs a browser session',
    request: { params: idParam },
    responses: { 204: { description: 'Revoked' }, 404: problem('Device not found'), ...authErrors },
});

export interface DeviceRouteDeps {
    repos: Repositories;
    now: () => Date;
    clientIp: (c: Context<AppEnv>) => string;
    /** 配对与刷新共用的失败限速;默认每个来源每分钟 10 次。 */
    pairLimiter?: AttemptLimiter;
}

export function deviceRoutes(deps: DeviceRouteDeps) {
    const { repos, now } = deps;
    const limiter = deps.pairLimiter ?? new FailureLimiter(10, 60_000);

    const forbidden = (detail: string) => new ApiError(403, 'forbidden', 'Forbidden', detail);

    /** 管理设备要完整的浏览器会话(启用了 TOTP 时还要通过第二因素);设备令牌与个人访问令牌都不行。 */
    function requireFullSession(c: Context<AppEnv>): string {
        const auth = c.get('auth');
        if (!auth) throw unauthorized();
        if (auth.kind !== 'session') throw forbidden('Managing devices needs a signed-in browser session.');
        if (repos.totp.get(auth.ownerId)?.enabled) {
            const session = repos.authSessions.getValid(auth.sessionHash);
            if (!session?.secondFactorAt)
                throw forbidden('Managing devices needs a session that passed the second factor.');
        }
        return auth.ownerId;
    }

    function guard(ip: string): void {
        const wait = limiter.retryAfter(ip);
        if (wait > 0) {
            throw new ApiError(429, 'rate_limited', 'Too Many Requests', 'Too many failed attempts.', {
                headers: { 'Retry-After': String(wait) },
            });
        }
    }

    function newTokens(): { plain: { access: string; refresh: string }; hashes: DeviceTokenHashes } {
        const access = newDeviceAccessToken();
        const refresh = newDeviceRefreshToken();
        const at = now().getTime();
        return {
            plain: { access, refresh },
            hashes: {
                accessHash: sha256(access),
                accessExpiresAt: new Date(at + ACCESS_TTL_MS),
                refreshHash: sha256(refresh),
                refreshExpiresAt: new Date(at + REFRESH_TTL_MS),
            },
        };
    }

    const body = (device: Device, t: ReturnType<typeof newTokens>) => ({
        device,
        accessToken: t.plain.access,
        accessExpiresAt: t.hashes.accessExpiresAt.toISOString(),
        refreshToken: t.plain.refresh,
        refreshExpiresAt: t.hashes.refreshExpiresAt.toISOString(),
    });

    return router()
        .openapi(createCodeRoute, (c) => {
            const ownerId = requireFullSession(c);
            const code = newPairingCode();
            const expiresAt = new Date(now().getTime() + PAIRING_CODE_TTL_MS);
            if (!repos.devices.createPairingCode(ownerId, sha256(normalizePairingCode(code)), expiresAt)) {
                throw new ApiError(
                    429,
                    'rate_limited',
                    'Too Many Requests',
                    'Too many unused pairing codes; wait for them to expire.',
                );
            }
            repos.devices.events.append(ownerId, {
                deviceId: null,
                event: 'pairing-code-created',
                summary: 'A pairing code was created',
            });
            c.header('Cache-Control', 'no-store');
            return c.json({ code, expiresAt: expiresAt.toISOString() }, 201);
        })
        .openapi(pairRoute, (c) => {
            const ip = deps.clientIp(c);
            guard(ip);
            const req = c.req.valid('json');
            const t = newTokens();
            const paired = repos.devices.pair(sha256(normalizePairingCode(req.code)), req.name, t.hashes);
            c.header('Cache-Control', 'no-store');
            if (!paired) {
                limiter.recordFailure(ip);
                // 码对应哪个账户不知道,失败事件记到主人名下(1.0 只有一个主人)
                const ownerId = repos.owners.ids()[0];
                if (ownerId) {
                    repos.devices.events.append(ownerId, {
                        deviceId: null,
                        event: 'pairing-failed',
                        summary: 'A pairing attempt failed (invalid, used or expired code)',
                    });
                }
                c.get('logger').warn({ ip }, 'device pairing failed');
                throw new ApiError(401, 'unauthorized', 'Unauthorized', 'The pairing code is invalid or has expired.');
            }
            limiter.reset(ip);
            repos.devices.events.append(paired.ownerId, {
                deviceId: paired.device.id,
                event: 'paired',
                summary: `Device "${paired.device.name}" was paired`,
            });
            c.get('logger').info({ deviceId: paired.device.id }, 'device paired');
            return c.json(body(paired.device, t), 201);
        })
        .openapi(refreshRoute, (c) => {
            const ip = deps.clientIp(c);
            guard(ip);
            const req = c.req.valid('json');
            const t = newTokens();
            const result = repos.devices.rotate(sha256(req.refreshToken), t.hashes);
            c.header('Cache-Control', 'no-store');
            if (result.status === 'invalid') {
                limiter.recordFailure(ip);
                throw new ApiError(401, 'unauthorized', 'Unauthorized', 'The refresh token is invalid or has expired.');
            }
            if (result.status === 'replay') {
                repos.devices.events.append(result.ownerId, {
                    deviceId: result.deviceId,
                    event: 'replay-revoked',
                    summary: 'A used refresh token was presented again; the device was revoked',
                });
                c.get('logger').warn({ deviceId: result.deviceId }, 'device refresh token reuse; device revoked');
                throw new ApiError(401, 'unauthorized', 'Unauthorized', 'The refresh token is invalid or has expired.');
            }
            repos.devices.events.append(result.ownerId, {
                deviceId: result.device.id,
                event: 'refreshed',
                summary: `Device "${result.device.name}" refreshed its tokens`,
            });
            return c.json(body(result.device, t), 200);
        })
        .openapi(listRoute, (c) => {
            repos.devices.purgeExpired();
            return c.json({ items: repos.devices.list(requireOwner(c)), nextCursor: null }, 200);
        })
        .openapi(eventsRoute, (c) => {
            const ownerId = requireFullSession(c);
            return c.json({ items: repos.devices.events.list(ownerId), nextCursor: null }, 200);
        })
        .openapi(selfRevokeRoute, (c) => {
            const auth = c.get('auth');
            if (!auth) throw unauthorized();
            if (auth.kind !== 'device') throw forbidden('Only a paired device can sign itself out.');
            if (repos.devices.revoke(auth.ownerId, auth.deviceId, 'self')) {
                repos.devices.events.append(auth.ownerId, {
                    deviceId: auth.deviceId,
                    event: 'self-revoked',
                    summary: 'A device signed itself out',
                });
            }
            return c.body(null, 204);
        })
        .openapi(renameRoute, (c) => {
            const ownerId = requireFullSession(c);
            const { id } = c.req.valid('param');
            const { name } = c.req.valid('json');
            if (!repos.devices.rename(ownerId, id, name)) throw notFound('Device');
            repos.devices.events.append(ownerId, {
                deviceId: id,
                event: 'renamed',
                summary: `Device renamed to "${name}"`,
            });
            const device = repos.devices.list(ownerId).find((d) => d.id === id);
            if (!device) throw notFound('Device');
            return c.json(device, 200);
        })
        .openapi(revokeRoute, (c) => {
            const ownerId = requireFullSession(c);
            const { id } = c.req.valid('param');
            if (!repos.devices.revoke(ownerId, id, 'owner')) throw notFound('Device');
            repos.devices.events.append(ownerId, { deviceId: id, event: 'revoked', summary: 'A device was revoked' });
            return c.body(null, 204);
        });
}
