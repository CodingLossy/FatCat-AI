// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件管理的 REST(ADR 0040 第 9 节):只有登录的主人能用,没有对应的 Agent 工具,模型不能安装、启用或改授权。
import { createRoute, z } from '@hono/zod-openapi';
import {
    PluginDetail,
    PluginEventView,
    PluginId,
    PluginInstallInput,
    PluginPatch,
    PluginPrepareInput,
    PluginPrepared,
    PluginView,
    pageOf,
} from '@fatcat-ai/shared';
import { requireOwner } from '../auth/middleware.js';
import type { PluginService } from '../plugin-setup.js';
import { authErrors, json, problem, router } from './common.js';

const tags = ['plugins'];
const idParam = z.object({ id: PluginId });

const listRoute = createRoute({
    method: 'get',
    path: '/plugins',
    tags,
    summary: 'List installed plugins with state, granted permissions and the latest memory reading',
    responses: { 200: json(pageOf(PluginView), 'Installed plugins'), ...authErrors },
});
const getRoute = createRoute({
    method: 'get',
    path: '/plugins/{id}',
    tags,
    summary: 'One plugin, including the tasks an uninstall would disable',
    request: { params: idParam },
    responses: { 200: json(PluginDetail, 'Plugin'), 404: problem('Not found'), ...authErrors },
});
const prepareRoute = createRoute({
    method: 'post',
    path: '/plugins/prepare',
    tags,
    summary: 'Copy and check a local plugin directory without running it; returns the permissions to confirm',
    request: { body: { content: { 'application/json': { schema: PluginPrepareInput } }, required: true } },
    responses: { 200: json(PluginPrepared, 'Prepared'), 400: problem('The package is invalid'), ...authErrors },
});
const installRoute = createRoute({
    method: 'post',
    path: '/plugins/install',
    tags,
    summary: 'Install a prepared package after the user accepted all of its permissions',
    request: { body: { content: { 'application/json': { schema: PluginInstallInput } }, required: true } },
    responses: {
        201: json(PluginView, 'Installed'),
        404: problem('The prepared package is gone'),
        409: problem('Already installed'),
        ...authErrors,
    },
});
const patchRoute = createRoute({
    method: 'patch',
    path: '/plugins/{id}',
    tags,
    summary: 'Enable or disable a plugin, bind secrets to env: references, change settings or runtime limits',
    request: { params: idParam, body: { content: { 'application/json': { schema: PluginPatch } }, required: true } },
    responses: {
        200: json(PluginView, 'Updated'),
        400: problem('Invalid request'),
        404: problem('Not found'),
        409: problem('Required secrets are not bound'),
        ...authErrors,
    },
});
const stopRoute = createRoute({
    method: 'post',
    path: '/plugins/{id}/stop',
    tags,
    summary: 'Stop the running process; the next call starts it again',
    request: { params: idParam },
    responses: { 204: { description: 'Stopped' }, 404: problem('Not found'), ...authErrors },
});
const deleteRoute = createRoute({
    method: 'delete',
    path: '/plugins/{id}',
    tags,
    summary: 'Uninstall; pending approvals are cancelled and tasks that use the plugin are disabled',
    request: { params: idParam, query: z.object({ purgeData: z.enum(['true', 'false']).optional() }) },
    responses: { 204: { description: 'Uninstalled' }, 404: problem('Not found'), ...authErrors },
});
const eventsRoute = createRoute({
    method: 'get',
    path: '/plugins/{id}/events',
    tags,
    summary: 'Lifecycle and denial events of a plugin (no parameters or secrets)',
    request: {
        params: idParam,
        query: z.object({
            cursor: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
    },
    responses: { 200: json(pageOf(PluginEventView), 'Events'), 404: problem('Not found'), ...authErrors },
});

export function pluginRoutes(deps: { plugins: PluginService }) {
    const { plugins } = deps;
    return router()
        .openapi(listRoute, (c) => c.json({ items: plugins.list(requireOwner(c)), nextCursor: null }, 200))
        .openapi(getRoute, (c) => c.json(plugins.detail(requireOwner(c), c.req.valid('param').id), 200))
        .openapi(prepareRoute, async (c) => {
            const body = c.req.valid('json');
            return c.json(await plugins.prepareLocal(requireOwner(c), body.source.path), 200);
        })
        .openapi(installRoute, async (c) => {
            const { stagingId } = c.req.valid('json');
            const view = await plugins.install(requireOwner(c), stagingId);
            c.get('logger').info({ plugin: view.id, version: view.version }, 'plugin installed');
            return c.json(view, 201);
        })
        .openapi(patchRoute, async (c) =>
            c.json(await plugins.patch(requireOwner(c), c.req.valid('param').id, c.req.valid('json')), 200),
        )
        .openapi(stopRoute, async (c) => {
            await plugins.stop(requireOwner(c), c.req.valid('param').id);
            return c.body(null, 204);
        })
        .openapi(deleteRoute, async (c) => {
            const { id } = c.req.valid('param');
            await plugins.uninstall(requireOwner(c), id, c.req.valid('query').purgeData === 'true');
            c.get('logger').info({ plugin: id }, 'plugin uninstalled');
            return c.body(null, 204);
        })
        .openapi(eventsRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            plugins.detail(ownerId, id); // 404 when unknown
            const { cursor, limit } = c.req.valid('query');
            return c.json(plugins.events(ownerId, id, { cursor, limit }), 200);
        });
}
