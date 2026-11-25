// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 账户管理(ADR 0053 第 2、6 节):只有管理员能用,而且要完整的浏览器会话(启用了 TOTP 时还要通过第二因素),
// 个人访问令牌与设备令牌都不行。管理员只看到账户本身,看不到成员的数据。
// OpenAPI 里用 `x-fatcat-admin: true` 标注,admin-scope.test.ts 用成员身份逐条扫这些路由。
import { createRoute, z } from '@hono/zod-openapi';
import {
    Account,
    AccountList,
    CreatedAccountCode,
    DeleteAccountRequest,
    Id,
    UpdateAccountRequest,
} from '@fatcat-ai/shared';
import type { AccountChange, AccountRecord, Repositories } from '@fatcat-ai/storage';
import type { Context } from 'hono';
import type { AccountLifecycle } from '../account-lifecycle.js';
import { newPairingCode, normalizePairingCode, sha256 } from '../auth/crypto.js';
import { requireAdmin } from '../auth/middleware.js';
import type { AppEnv } from '../env.js';
import { ApiError, notFound, unauthorized } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

/** 邀请码与重置码的有效期。 */
export const ACCOUNT_CODE_TTL_MS = 24 * 60 * 60 * 1000;

const ADMIN = { 'x-fatcat-admin': true } as const;
const idParam = z.object({ id: Id });
const adminErrors = {
    ...authErrors,
    403: problem('Not an admin (admin_required), not a browser session, or CSRF token missing'),
};

const listRoute = createRoute({
    method: 'get',
    path: '/admin/users',
    tags: ['accounts'],
    summary: 'List accounts (admin only): username, display name, role, disabled, TOTP; never their data',
    ...ADMIN,
    responses: { 200: json(AccountList, 'Accounts'), ...adminErrors },
});

const inviteRoute = createRoute({
    method: 'post',
    path: '/admin/users/invites',
    tags: ['accounts'],
    summary: 'Create a one-time invite code (admin only, 24 hours); the person sets their own username and password',
    ...ADMIN,
    responses: {
        201: json(CreatedAccountCode, 'Created'),
        429: problem('Too many unused codes'),
        ...adminErrors,
    },
});

const resetCodeRoute = createRoute({
    method: 'post',
    path: '/admin/users/{id}/reset-code',
    tags: ['accounts'],
    summary: 'Create a one-time password reset code for another account (admin only, 24 hours)',
    ...ADMIN,
    request: { params: idParam },
    responses: {
        201: json(CreatedAccountCode, 'Created'),
        404: problem('No such account'),
        409: problem('Your own account (ask another admin)'),
        429: problem('Too many unused codes'),
        ...adminErrors,
    },
});

const updateRoute = createRoute({
    method: 'patch',
    path: '/admin/users/{id}',
    tags: ['accounts'],
    summary:
        'Change role, disabled state or display name (admin only); disabling signs out every session, token and device',
    ...ADMIN,
    request: {
        params: idParam,
        body: { content: { 'application/json': { schema: UpdateAccountRequest } }, required: true },
    },
    responses: {
        200: json(Account, 'Updated'),
        404: problem('No such account'),
        409: problem('Your own role or state, or the last active admin'),
        ...adminErrors,
    },
});

const deleteRoute = createRoute({
    method: 'delete',
    path: '/admin/users/{id}',
    tags: ['accounts'],
    summary:
        "Delete an account and all of its data (admin only); the database is backed up first and the account's secrets lines are removed",
    ...ADMIN,
    request: {
        params: idParam,
        body: { content: { 'application/json': { schema: DeleteAccountRequest } }, required: true },
    },
    responses: {
        204: { description: 'Deleted' },
        400: problem('The confirmation does not match the username'),
        404: problem('No such account'),
        409: problem('Your own account, or the last active admin'),
        ...adminErrors,
    },
});

export interface AccountRouteDeps {
    repos: Repositories;
    now: () => Date;
    lifecycle: AccountLifecycle;
    /** 删除账户前备份数据库,返回备份文件路径。 */
    backup: (tag: string) => Promise<string>;
}

const toAccount = (a: AccountRecord): Account => ({
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    role: a.role,
    disabled: a.disabledAt !== null,
    totpEnabled: a.totpEnabled,
    createdAt: a.createdAt,
});

const conflict = (detail: string) => new ApiError(409, 'conflict', 'Conflict', detail);

export function accountRoutes(deps: AccountRouteDeps) {
    const { repos, now, lifecycle } = deps;

    /** 管理员 + 完整的浏览器会话(启用 TOTP 时要求通过第二因素)。 */
    function requireAdminSession(c: Context<AppEnv>): string {
        const auth = c.get('auth');
        if (!auth) throw unauthorized();
        const ownerId = requireAdmin(c, repos);
        if (auth.kind !== 'session') {
            throw new ApiError(403, 'forbidden', 'Forbidden', 'Managing accounts needs a signed-in browser session.');
        }
        if (repos.totp.get(ownerId)?.enabled && !repos.authSessions.getValid(auth.sessionHash)?.secondFactorAt) {
            throw new ApiError(
                403,
                'forbidden',
                'Forbidden',
                'Managing accounts needs a session that passed the second factor.',
            );
        }
        return ownerId;
    }

    function account(id: string): AccountRecord {
        const found = repos.accounts.get(id);
        if (!found) throw notFound('account');
        return found;
    }

    function changed(result: AccountChange): void {
        if (result === 'not_found') throw notFound('account');
        if (result === 'last_admin') throw conflict('At least one active admin is required.');
    }

    function newCode(c: Context<AppEnv>, adminId: string, kind: 'invite' | 'reset', targetOwnerId: string | null) {
        const code = newPairingCode();
        const expiresAt = new Date(now().getTime() + ACCOUNT_CODE_TTL_MS);
        const created = repos.accounts.createCode({
            adminId,
            kind,
            targetOwnerId,
            codeHash: sha256(normalizePairingCode(code)),
            expiresAt,
        });
        if (!created) {
            throw new ApiError(
                429,
                'rate_limited',
                'Too Many Requests',
                'Too many unused codes; wait for them to expire.',
            );
        }
        c.header('Cache-Control', 'no-store');
        return { kind, code, expiresAt: expiresAt.toISOString() };
    }

    return router()
        .openapi(listRoute, (c) => {
            requireAdminSession(c);
            return c.json({ accounts: repos.accounts.list().map(toAccount) }, 200);
        })
        .openapi(inviteRoute, (c) => {
            const adminId = requireAdminSession(c);
            const body = newCode(c, adminId, 'invite', null);
            c.get('logger').info({ ownerId: adminId }, 'invite code created');
            return c.json(body, 201);
        })
        .openapi(resetCodeRoute, (c) => {
            const adminId = requireAdminSession(c);
            const { id } = c.req.valid('param');
            const target = account(id);
            if (target.id === adminId) throw conflict('Ask another admin to create a reset code for your account.');
            const body = newCode(c, adminId, 'reset', target.id);
            c.get('logger').info({ ownerId: adminId, target: target.id }, 'reset code created');
            return c.json(body, 201);
        })
        .openapi(updateRoute, async (c) => {
            const adminId = requireAdminSession(c);
            const { id } = c.req.valid('param');
            const body = c.req.valid('json');
            const target = account(id);
            if (target.id === adminId && (body.role !== undefined || body.disabled !== undefined)) {
                throw conflict('You cannot change your own role or disable your own account.');
            }
            if (body.role !== undefined && body.role !== target.role) changed(repos.accounts.setRole(id, body.role));
            if (body.disabled !== undefined && body.disabled !== (target.disabledAt !== null)) {
                changed(repos.accounts.setDisabled(id, body.disabled));
                if (body.disabled) await lifecycle.disabled(id);
                else await lifecycle.enabled(id);
            }
            if (body.displayName !== undefined) repos.accounts.setDisplayName(id, body.displayName);
            c.get('logger').info({ ownerId: adminId, target: id, fields: Object.keys(body) }, 'account updated');
            return c.json(toAccount(account(id)), 200);
        })
        .openapi(deleteRoute, async (c) => {
            const adminId = requireAdminSession(c);
            const { id } = c.req.valid('param');
            const body = c.req.valid('json');
            const target = account(id);
            if (target.id === adminId) throw conflict('You cannot delete your own account.');
            if (body.confirmUsername !== target.username) {
                throw new ApiError(
                    400,
                    'validation_failed',
                    'Bad Request',
                    'Type the username of the account to confirm.',
                );
            }
            if (target.role === 'admin' && target.disabledAt === null) {
                // 只剩这一个未停用管理员时,触发器会拒绝;先检查,免得白做备份和停机
                const others = repos.accounts.list().filter((a) => a.role === 'admin' && a.disabledAt === null);
                if (others.length <= 1) throw conflict('At least one active admin is required.');
            }
            const backupPath = await deps.backup('delete-account');
            const qqChannels = await lifecycle.beforeDelete(id);
            changed(repos.accounts.remove(id));
            lifecycle.afterDelete(id, qqChannels);
            c.get('logger').info({ ownerId: adminId, target: id, backup: backupPath }, 'account deleted');
            return c.body(null, 204);
        });
}
