// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createRoute } from '@hono/zod-openapi';
import { Settings, SettingsPatch } from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
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
            // 语音默认配置档必须是 OpenAI 兼容且声明了对应用途(ADR 0021 第 1、2 节)
            for (const [key, purpose] of [
                ['defaultSttProfileId', 'stt'],
                ['defaultTtsProfileId', 'tts'],
            ] as const) {
                const id = patch.voice?.[key];
                if (!id) continue;
                const p = repos.modelProfiles.get(ownerId, id);
                const message = !p
                    ? 'Model profile does not exist'
                    : p.kind !== 'openai-compatible' || !p.purpose.includes(purpose)
                      ? `Model profile must be openai-compatible with purpose ${purpose}`
                      : null;
                if (message) {
                    throw new ApiError(400, 'validation_failed', 'Bad Request', 'The request is invalid.', {
                        issues: [{ path: ['voice', key], message }],
                    });
                }
            }
            return c.json(repos.settings.update(ownerId, patch), 200);
        });
}
