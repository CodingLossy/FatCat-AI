// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute, z } from '@hono/zod-openapi';
import { Id, ModelProfile, ModelProfileInput, ModelProfilePatch, ModelTestResult, pageOf } from '@fatcat-ai/shared';
import { createProvider, type ProviderDeps, type SecretStore } from '@fatcat-ai/providers';
import type { ModelProfileRecord, Repositories, UsableProfileRecord } from '@fatcat-ai/storage';
import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import { ownerSecrets, refAllowed, scopeSecretRef } from '../member-secrets.js';
import { requireAdmin, requireOwner } from '../auth/middleware.js';
import { ApiError, notFound, validationError } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

export interface ModelRouteDeps {
    repos: Repositories;
    secrets: SecretStore;
    providerDeps: ProviderDeps;
    /** 配置档变化后调用(例如让嵌入队列重新检查 embed 配置档,ADR 0014)。 */
    onChanged?: () => void;
}

const idParam = z.object({ id: Id });

const listRoute = createRoute({
    method: 'get',
    path: '/models',
    tags: ['models'],
    summary: 'List model profiles',
    responses: { 200: json(pageOf(ModelProfile), 'Profiles'), ...authErrors },
});

const createProfileRoute = createRoute({
    method: 'post',
    path: '/models',
    tags: ['models'],
    summary:
        'Create a model profile; keys are referenced as env:NAME or file:NAME, never sent in plaintext. Only admins can create an embed profile (403 admin_required)',
    request: { body: { content: { 'application/json': { schema: ModelProfileInput } }, required: true } },
    responses: {
        201: json(ModelProfile, 'Created'),
        400: problem('Invalid request'),
        ...authErrors,
        403: problem('CSRF token missing or invalid, or a member asking for the embed purpose (admin_required)'),
    },
});

const getRoute = createRoute({
    method: 'get',
    path: '/models/{id}',
    tags: ['models'],
    summary: 'Get a model profile',
    request: { params: idParam },
    responses: { 200: json(ModelProfile, 'Profile'), 404: problem('Not found'), ...authErrors },
});

const patchRoute = createRoute({
    method: 'patch',
    path: '/models/{id}',
    tags: ['models'],
    summary: 'Update a model profile',
    request: {
        params: idParam,
        body: { content: { 'application/json': { schema: ModelProfilePatch } }, required: true },
    },
    responses: {
        200: json(ModelProfile, 'Updated'),
        400: problem('Invalid request'),
        404: problem('Not found'),
        ...authErrors,
    },
});

const deleteRoute = createRoute({
    method: 'delete',
    path: '/models/{id}',
    tags: ['models'],
    summary: 'Delete a model profile; sessions using it keep working with the default profile',
    request: { params: idParam },
    responses: { 204: { description: 'Deleted' }, 404: problem('Not found'), ...authErrors },
});

const testRoute = createRoute({
    method: 'post',
    path: '/models/{id}/test',
    tags: ['models'],
    summary: 'Test the connection of a model profile',
    request: { params: idParam },
    responses: {
        200: json(ModelTestResult, 'Result (also for failed connections)'),
        404: problem('Not found'),
        409: problem('The key reference is not available to this account'),
        ...authErrors,
    },
});

export function modelRoutes(deps: ModelRouteDeps) {
    const { repos, secrets } = deps;
    /** keyStatus 按配置档所属账户检查引用:管理员降为成员后,env: 等引用显示为缺失(ADR 0053 第 5 节)。 */
    const keyStatus = (ownerId: string, ref: string | null) => ownerSecrets(repos, secrets, ownerId).status(ref);
    const withStatus = (p: ModelProfileRecord, ownerId: string): ModelProfile => {
        const { shared, ...rest } = p;
        return { ...rest, ...(shared ? { shared: true } : {}), keyStatus: keyStatus(ownerId, p.apiKeyRef) };
    };
    /**
     * 管理员共享来的配置档给别的账户看的样子(ADR 0053 第 5.1 节):名称、类型、模型名、用途照常,
     * 地址和密钥引用不给;keyStatus 仍按真实引用计算,成员能看出能不能用。
     */
    const sharedView = (p: UsableProfileRecord): ModelProfile => {
        return {
            id: p.id,
            label: p.label,
            kind: p.kind,
            model: p.model,
            purpose: p.purpose,
            ...(p.contextWindow === undefined ? {} : { contextWindow: p.contextWindow }),
            ...(p.vision === undefined ? {} : { vision: p.vision }),
            apiKeyRef: null,
            shared: true,
            readOnly: true,
            keyStatus: keyStatus(p.ownerId, p.apiKeyRef),
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
        };
    };
    const view = (ownerId: string) => (p: UsableProfileRecord) =>
        p.ownerId === ownerId ? withStatus(p, ownerId) : sharedView(p);
    /**
     * 共享给成员只有管理员能设;密钥引用按账户检查和换算(第 5 节)。修改时没变的字段不再检查,
     * 这样降为成员的账户还能改自己配置档的名称(但不能再新设 env: 引用或打开共享)。
     */
    const checkInput = (
        c: Context<AppEnv>,
        ownerId: string,
        input: ModelProfileInput,
        existing?: ModelProfileRecord,
    ): ModelProfileInput => {
        if (input.shared === true && !existing?.shared) requireAdmin(c, repos);
        if (existing && input.apiKeyRef === existing.apiKeyRef) return input;
        return { ...input, apiKeyRef: scopeSecretRef(repos, ownerId, input.apiKeyRef, 'apiKeyRef') };
    };
    /** 嵌入模型整个安装共用(换模型要重建全部向量),只有管理员能设(ADR 0053 第 8 节)。 */
    const requireEmbedAdmin = (c: Parameters<typeof requireOwner>[0]) => requireAdmin(c, repos);

    return router()
        .openapi(listRoute, (c) => {
            const ownerId = requireOwner(c);
            return c.json({ items: repos.modelProfiles.listUsable(ownerId).map(view(ownerId)), nextCursor: null }, 200);
        })
        .openapi(createProfileRoute, (c) => {
            const ownerId = requireOwner(c);
            const input = checkInput(c, ownerId, c.req.valid('json'));
            if (input.purpose.includes('embed')) requireEmbedAdmin(c);
            const created = repos.modelProfiles.create(ownerId, input);
            c.get('logger').info({ profileId: created.id, kind: created.kind }, 'model profile created');
            deps.onChanged?.();
            return c.json(withStatus(created, ownerId), 201);
        })
        .openapi(getRoute, (c) => {
            const ownerId = requireOwner(c);
            const p = repos.modelProfiles.getUsable(ownerId, c.req.valid('param').id);
            if (!p) throw notFound('Model profile');
            return c.json(view(ownerId)(p), 200);
        })
        .openapi(patchRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            const existing = repos.modelProfiles.get(ownerId, id);
            if (!existing) throw notFound('Model profile');
            const current = {
                label: existing.label,
                kind: existing.kind,
                baseURL: existing.baseURL,
                apiKeyRef: existing.apiKeyRef,
                model: existing.model,
                purpose: existing.purpose,
                contextWindow: existing.contextWindow,
                params: existing.params,
                vision: existing.vision,
                shared: existing.shared || undefined,
            };
            // 合并后按完整输入重新校验(例如改为 openai-compatible 时必须有 baseURL)
            const merged = ModelProfileInput.safeParse(
                Object.fromEntries(
                    Object.entries({ ...current, ...c.req.valid('json') }).filter(([, v]) => v !== undefined),
                ),
            );
            if (!merged.success) throw validationError(merged.error);
            const checked = checkInput(c, ownerId, merged.data, existing);
            if (merged.data.purpose.includes('embed') && !existing.purpose.includes('embed')) requireEmbedAdmin(c);
            const replaced = repos.modelProfiles.replace(ownerId, id, checked)!;
            deps.onChanged?.();
            return c.json(withStatus(replaced, ownerId), 200);
        })
        .openapi(deleteRoute, (c) => {
            if (!repos.modelProfiles.delete(requireOwner(c), c.req.valid('param').id)) throw notFound('Model profile');
            deps.onChanged?.();
            return c.body(null, 204);
        })
        .openapi(testRoute, async (c) => {
            const ownerId = requireOwner(c);
            const p = repos.modelProfiles.get(ownerId, c.req.valid('param').id);
            if (!p) throw notFound('Model profile');
            // 这个账户用不了的引用(管理员降为成员后的 env: 等):不发请求,和发消息一样回 409(ADR 0053 第 5 节)
            if (!refAllowed(repos, ownerId, p.apiKeyRef)) {
                throw new ApiError(
                    409,
                    'model_key_missing',
                    'Conflict',
                    `The key referenced by ${p.apiKeyRef ?? ''} is not available to this account.`,
                );
            }
            const providerDeps = {
                ...deps.providerDeps,
                secrets: ownerSecrets(repos, deps.providerDeps.secrets, ownerId),
            };
            const result = await createProvider({ ...p, id: p.id }, providerDeps).test(c.req.raw.signal);
            c.get('logger').info(
                { profileId: p.id, ok: result.ok, ...(result.ok ? {} : { error: result.error }) },
                'model test',
            );
            return c.json(result, 200);
        });
}
