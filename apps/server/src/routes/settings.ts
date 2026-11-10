// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute } from '@hono/zod-openapi';
import { Settings, SettingsPatch } from '@ai-personal/shared';
import type { Repositories } from '@ai-personal/storage';
import { requireOwner } from '../auth/middleware.js';
import { ApiError } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

const getRoute = createRoute({
    method: 'get',
    path: '/settings',
    tags: ['settings'],
    summary: 'Get settings (defaults are filled in for keys never set)',
    responses: { 200: json(Settings, 'Settings'), ...authErrors },
});

const putRoute = createRoute({
    method: 'put',
    path: '/settings',
    tags: ['settings'],
    summary: 'Update settings; only the given keys change and memory is merged',
    request: { body: { content: { 'application/json': { schema: SettingsPatch } }, required: true } },
    responses: { 200: json(Settings, 'Updated settings'), 400: problem('Invalid request'), ...authErrors },
});

export function settingsRoutes(deps: { repos: Repositories }) {
    const { repos } = deps;
    return router()
        .openapi(getRoute, (c) => c.json(repos.settings.get(requireOwner(c)), 200))
        .openapi(putRoute, (c) => {
            const ownerId = requireOwner(c);
            const patch = c.req.valid('json');
            for (const key of ['defaultChatProfileId', 'defaultCheapProfileId'] as const) {
                const id = patch[key];
                if (id && !repos.modelProfiles.get(ownerId, id)) {
                    throw new ApiError(400, 'validation_failed', 'Bad Request', 'The request is invalid.', {
                        issues: [{ path: [key], message: 'Model profile does not exist' }],
                    });
                }
            }
            return c.json(repos.settings.update(ownerId, patch), 200);
        });
}
