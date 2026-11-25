// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 每个账户自己管理 secrets.yaml 里的键(ADR 0053 第 5 节):只列名字、只写不读。
// 成员写入的键带 `U<ownerId>_` 前缀,成员看到的名字不带前缀;管理员管理不带前缀的键。
// 渠道自己的键(微信、QQ)和别的账户的键都不出现在列表里,也不能通过这里改。
import { createRoute, z } from '@hono/zod-openapi';
import {
    type SecretStore,
    SecretsKeyUnavailableError,
    SecretsLayoutError,
    SecretsWriteError,
} from '@fatcat-ai/providers';
import { SecretKey, SecretKeyInput, SecretKeyList } from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import { isActiveAdmin, requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import { CHANNEL_KEY, MEMBER_KEY, memberSecretPrefix, storedKeyName, visibleKeyName } from '../member-secrets.js';
import { authErrors, json, problem, router } from './common.js';

const tags = ['settings'];
const nameParam = z.object({ name: z.string().min(1).max(64) });

const listRoute = createRoute({
    method: 'get',
    path: '/settings/secret-keys',
    tags,
    summary:
        'Names of the secrets this account saved, with the file: reference to use in model profiles and mail accounts (values are never returned). Members see only their own keys; admins see the keys without an account prefix, except channel keys',
    responses: {
        200: json(SecretKeyList, 'Keys'),
        409: problem('The master key is unavailable or the secrets files conflict'),
        ...authErrors,
    },
});
const putRoute = createRoute({
    method: 'put',
    path: '/settings/secret-keys/{name}',
    tags,
    summary:
        "Save a secret (add or replace). Only the one line changes and the previous file is backed up first. A member's key is stored under their own account prefix",
    request: {
        params: nameParam,
        body: { content: { 'application/json': { schema: SecretKeyInput } }, required: true },
    },
    responses: {
        200: json(SecretKey, 'Saved'),
        400: problem('Invalid or reserved name, or an invalid value'),
        409: problem('The master key is unavailable or the secrets files conflict'),
        ...authErrors,
    },
});
const deleteRoute = createRoute({
    method: 'delete',
    path: '/settings/secret-keys/{name}',
    tags,
    summary: 'Delete a secret this account saved. Profiles and mail accounts that refer to it show the key as missing',
    request: { params: nameParam },
    responses: {
        204: { description: 'Deleted' },
        400: problem('Invalid or reserved name'),
        404: problem('No such key'),
        409: problem('The master key is unavailable or the secrets files conflict'),
        ...authErrors,
    },
});

/** 密钥文件读写失败时给出能看懂的错误,不带任何值。 */
function storeError(error: unknown): never {
    if (error instanceof SecretsKeyUnavailableError) {
        throw new ApiError(
            409,
            'conflict',
            'Conflict',
            'The master key is unavailable, so secrets cannot be read or saved. Ask the admin to check the master key.',
        );
    }
    if (error instanceof SecretsLayoutError) {
        throw new ApiError(409, 'conflict', 'Conflict', error.message);
    }
    if (error instanceof SecretsWriteError) {
        throw new ApiError(500, 'internal', 'Internal Server Error', `${error.message}. Nothing was changed.`);
    }
    throw error;
}

export function secretKeyRoutes(deps: {
    repos: Repositories;
    secrets: Pick<SecretStore, 'keyNames' | 'write' | 'remove'>;
}) {
    const { repos, secrets } = deps;
    /** 这个账户能看到的键(存储里的名字)。 */
    const ownKeys = (ownerId: string): string[] => {
        let names: string[];
        try {
            names = secrets.keyNames();
        } catch (error) {
            storeError(error);
        }
        if (isActiveAdmin(repos, ownerId)) return names.filter((n) => !MEMBER_KEY.test(n) && !CHANNEL_KEY.test(n));
        const prefix = memberSecretPrefix(ownerId);
        return names.filter((n) => n.startsWith(prefix));
    };
    const entry = (ownerId: string, stored: string): SecretKey => ({
        name: visibleKeyName(ownerId, stored),
        ref: `file:${stored}`,
    });
    return router()
        .openapi(listRoute, (c) => {
            const ownerId = requireOwner(c);
            const items = ownKeys(ownerId)
                .sort()
                .map((n) => entry(ownerId, n));
            return c.json({ items }, 200);
        })
        .openapi(putRoute, (c) => {
            const ownerId = requireOwner(c);
            const stored = storedKeyName(repos, ownerId, c.req.valid('param').name);
            try {
                secrets.write(stored, c.req.valid('json').value);
            } catch (error) {
                storeError(error);
            }
            c.get('logger').info({ secretKey: stored }, 'secret saved');
            return c.json(entry(ownerId, stored), 200);
        })
        .openapi(deleteRoute, (c) => {
            const ownerId = requireOwner(c);
            const stored = storedKeyName(repos, ownerId, c.req.valid('param').name);
            if (!ownKeys(ownerId).includes(stored)) throw notFound('Secret');
            try {
                secrets.remove(stored);
            } catch (error) {
                storeError(error);
            }
            c.get('logger').info({ secretKey: stored }, 'secret deleted');
            return c.body(null, 204);
        });
}
