// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute, z } from '@hono/zod-openapi';
import { AccessToken, CreatedAccessToken, CreateTokenRequest, Id, pageOf } from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import { newAccessToken, sha256 } from '../auth/crypto.js';
import { requireOwner } from '../auth/middleware.js';
import { notFound } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const listRoute = createRoute({
    method: 'get',
    path: '/tokens',
    tags: ['tokens'],
    summary: 'List personal access tokens that are not revoked',
    responses: { 200: json(pageOf(AccessToken), 'Tokens'), ...authErrors },
});

const createTokenRoute = createRoute({
    method: 'post',
    path: '/tokens',
    tags: ['tokens'],
    summary: 'Create a personal access token; the plaintext token is returned only once',
    request: { body: { content: { 'application/json': { schema: CreateTokenRequest } }, required: true } },
    responses: { 201: json(CreatedAccessToken, 'Created'), 400: problem('Invalid request'), ...authErrors },
});

const revokeRoute = createRoute({
    method: 'delete',
    path: '/tokens/{id}',
    tags: ['tokens'],
    summary: 'Revoke a personal access token',
    request: { params: z.object({ id: Id }) },
    responses: { 204: { description: 'Revoked' }, 404: problem('Token not found'), ...authErrors },
});

export function tokenRoutes(deps: { repos: Repositories; now: () => Date }) {
    const { repos, now } = deps;
    return router()
        .openapi(listRoute, (c) => c.json({ items: repos.accessTokens.list(requireOwner(c)), nextCursor: null }, 200))
        .openapi(createTokenRoute, (c) => {
            const body = c.req.valid('json');
            const token = newAccessToken();
            const expiresAt = body.expiresInDays ? new Date(now().getTime() + body.expiresInDays * DAY_MS) : null;
            const created = repos.accessTokens.create({
                ownerId: requireOwner(c),
                name: body.name,
                tokenHash: sha256(token),
                expiresAt,
            });
            c.get('logger').info({ tokenId: created.id }, 'access token created');
            return c.json({ ...created, token }, 201);
        })
        .openapi(revokeRoute, (c) => {
            if (!repos.accessTokens.revoke(requireOwner(c), c.req.valid('param').id)) throw notFound('Token');
            return c.body(null, 204);
        });
}
