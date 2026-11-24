// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// GET /api/v1/skills(ADR 0048 第 10 节):已安装的 Skill(内置与插件提供的),含是否启用;只读。
import { createRoute } from '@hono/zod-openapi';
import { pageOf, SkillInfo } from '@fatcat-ai/shared';
import { requireOwner } from '../auth/middleware.js';
import type { SkillService } from '../skills.js';
import { authErrors, json, router } from './common.js';

const listRoute = createRoute({
    method: 'get',
    path: '/skills',
    tags: ['skills'],
    summary: 'List installed skills (built-in and from plugins), whether each is enabled, and its tool set',
    responses: { 200: json(pageOf(SkillInfo), 'Skills'), ...authErrors },
});

export function skillRoutes(deps: { skills: SkillService }) {
    return router().openapi(listRoute, (c) => {
        const ownerId = requireOwner(c);
        return c.json({ items: deps.skills.all(ownerId), nextCursor: null }, 200);
    });
}
