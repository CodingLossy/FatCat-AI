// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute, z } from '@hono/zod-openapi';
import { Id, ModelProfile, ModelProfileInput, ModelProfilePatch, ModelTestResult, pageOf } from '@fatcat-ai/shared';
import { createProvider, type ProviderDeps, type SecretStore } from '@fatcat-ai/providers';
import type { ModelProfileRecord, Repositories } from '@fatcat-ai/storage';
import { requireOwner } from '../auth/middleware.js';
import { notFound, validationError } from '../errors.js';
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
    summary: 'Create a model profile; keys are referenced as env:NAME or file:NAME, never sent in plaintext',
    request: { body: { content: { 'application/json': { schema: ModelProfileInput } }, required: true } },
    responses: { 201: json(ModelProfile, 'Created'), 400: problem('Invalid request'), ...authErrors },
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
        ...authErrors,
    },
});

export function modelRoutes(deps: ModelRouteDeps) {
    const { repos, secrets } = deps;
    const withStatus = (p: ModelProfileRecord): ModelProfile => ({ ...p, keyStatus: secrets.status(p.apiKeyRef) });

    return router()
        .openapi(listRoute, (c) =>
            c.json({ items: repos.modelProfiles.list(requireOwner(c)).map(withStatus), nextCursor: null }, 200),
        )
        .openapi(createProfileRoute, (c) => {
            const created = repos.modelProfiles.create(requireOwner(c), c.req.valid('json'));
            c.get('logger').info({ profileId: created.id, kind: created.kind }, 'model profile created');
            deps.onChanged?.();
            return c.json(withStatus(created), 201);
        })
        .openapi(getRoute, (c) => {
            const p = repos.modelProfiles.get(requireOwner(c), c.req.valid('param').id);
            if (!p) throw notFound('Model profile');
            return c.json(withStatus(p), 200);
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
            };
            // 合并后按完整输入重新校验(例如改为 openai-compatible 时必须有 baseURL)
            const merged = ModelProfileInput.safeParse(
                Object.fromEntries(
                    Object.entries({ ...current, ...c.req.valid('json') }).filter(([, v]) => v !== undefined),
                ),
            );
            if (!merged.success) throw validationError(merged.error);
            const replaced = repos.modelProfiles.replace(ownerId, id, merged.data)!;
            deps.onChanged?.();
            return c.json(withStatus(replaced), 200);
        })
        .openapi(deleteRoute, (c) => {
            if (!repos.modelProfiles.delete(requireOwner(c), c.req.valid('param').id)) throw notFound('Model profile');
            deps.onChanged?.();
            return c.body(null, 204);
        })
        .openapi(testRoute, async (c) => {
            const p = repos.modelProfiles.get(requireOwner(c), c.req.valid('param').id);
            if (!p) throw notFound('Model profile');
            const result = await createProvider({ ...p, id: p.id }, deps.providerDeps).test(c.req.raw.signal);
            c.get('logger').info(
                { profileId: p.id, ok: result.ok, ...(result.ok ? {} : { error: result.error }) },
                'model test',
            );
            return c.json(result, 200);
        });
}
