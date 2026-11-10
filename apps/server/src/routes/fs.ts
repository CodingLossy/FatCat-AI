// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 授权目录的 REST(ADR 0011 第 1 节):只有用户能增删与选择是否进入知识库(ADR 0015 第 6 节),没有对应的工具。
import { createRoute, z } from '@hono/zod-openapi';
import { FsRoot, FsRootInput, FsRootPatch, Id, pageOf } from '@fatcat-ai/shared';
import type { ItemService } from '@fatcat-ai/items';
import type { Repositories } from '@fatcat-ai/storage';
import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import { inputDigest, isWithin, normalizeRoot, PathError } from '@fatcat-ai/tools';
import { requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

const listRoute = createRoute({
    method: 'get',
    path: '/fs/roots',
    tags: ['tools'],
    summary: 'List the folders the file tools may access',
    responses: { 200: json(pageOf(FsRoot), 'Authorized folders'), ...authErrors },
});

const createRootRoute = createRoute({
    method: 'post',
    path: '/fs/roots',
    tags: ['tools'],
    summary: 'Authorize a folder; the server stores its real path (realpath)',
    request: { body: { content: { 'application/json': { schema: FsRootInput } }, required: true } },
    responses: {
        201: json(FsRoot, 'Authorized'),
        400: problem('Not a folder, a whole drive, a network path or otherwise not allowed'),
        409: problem('Already authorized'),
        ...authErrors,
    },
});

const deleteRoute = createRoute({
    method: 'delete',
    path: '/fs/roots/{id}',
    tags: ['tools'],
    summary: 'Revoke a folder; file-tool pre-authorizations inside it are removed too',
    request: { params: z.object({ id: Id }) },
    responses: { 204: { description: 'Revoked' }, 404: problem('Not found'), ...authErrors },
});

const patchRoute = createRoute({
    method: 'patch',
    path: '/fs/roots/{id}',
    tags: ['tools'],
    summary: 'Choose whether the files in an authorized folder go into the knowledge base',
    request: {
        params: z.object({ id: Id }),
        body: { content: { 'application/json': { schema: FsRootPatch } }, required: true },
    },
    responses: {
        200: json(FsRoot, 'Updated'),
        400: problem('Invalid request'),
        404: problem('Not found'),
        ...authErrors,
    },
});

export function fsRoutes(deps: { repos: Repositories; items: ItemService; redact: (text: string) => string }) {
    const { repos } = deps;
    return router()
        .openapi(listRoute, (c) => c.json({ items: repos.fsRoots.list(requireOwner(c)), nextCursor: null }, 200))
        .openapi(createRootRoute, (c) => {
            const ownerId = requireOwner(c);
            const body = c.req.valid('json');
            let real: string;
            try {
                real = normalizeRoot(body.path);
            } catch (error) {
                const message = error instanceof PathError ? error.message : 'The folder cannot be used.';
                throw new ApiError(400, 'validation_failed', 'Bad Request', message, {
                    issues: [{ path: ['path'], message }],
                });
            }
            if (repos.fsRoots.list(ownerId).some((r) => isWithin(r.path, real) && isWithin(real, r.path))) {
                throw new ApiError(409, 'conflict', 'Conflict', 'This folder is already authorized.');
            }
            const root = repos.fsRoots.create(ownerId, {
                path: real,
                label: body.label?.trim() || real,
                knowledgeBase: body.knowledgeBase ?? false,
            });
            refreshItems(c, ownerId);
            c.get('logger').info({ rootId: root.id }, 'folder authorized');
            return c.json(root, 201);
        })
        .openapi(patchRoute, (c) => {
            const ownerId = requireOwner(c);
            const root = repos.fsRoots.setKnowledgeBase(
                ownerId,
                c.req.valid('param').id,
                c.req.valid('json').knowledgeBase,
            );
            if (!root) throw notFound('Authorized folder');
            // 条目同步结束后知识库会重新索引:新勾选的目录入库,取消勾选的目录清理分块与向量
            refreshItems(c, ownerId);
            return c.json(root, 200);
        })
        .openapi(deleteRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            const root = repos.fsRoots.get(ownerId, id);
            if (!root || !repos.fsRoots.delete(ownerId, id)) throw notFound('Authorized folder');
            // 撤销目录时,路径前缀落在它里面的文件工具预授权一并删除(ADR 0010 第 3 节、ADR 0011 第 1 节)
            for (const p of repos.preauths.list(ownerId)) {
                const prefix = p.constraint?.pathPrefix;
                if (!p.toolName.startsWith('fs.') || !prefix || !isWithin(prefix, root.path)) continue;
                repos.preauths.delete(ownerId, p.id);
                repos.audit.append(ownerId, {
                    action: 'preauth-revoked',
                    toolName: p.toolName,
                    risk: 'write',
                    callId: null,
                    runId: null,
                    sessionId: p.sessionId,
                    decision: null,
                    outcome: 'ok',
                    summary: `Revoked pre-authorization for ${p.toolName} because its folder was removed`,
                    inputDigest: inputDigest(p.constraint, deps.redact),
                    error: null,
                });
            }
            refreshItems(c, ownerId);
            return c.body(null, 204);
        });

    /** 授权目录变化后在后台重新同步条目索引(撤销时对应子树软删除);下一次读取会等它完成。 */
    function refreshItems(c: Context<AppEnv>, ownerId: string): void {
        deps.items.invalidate(ownerId);
        deps.items.sync(ownerId).catch((err: unknown) => c.get('logger').warn({ err }, 'item sync failed'));
    }
}
