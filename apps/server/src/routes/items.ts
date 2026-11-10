// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 条目索引 REST(ADR 0012 第 2 节):只读;已删除的条目只出现在 /items/changes 中。
import { createRoute, z } from '@hono/zod-openapi';
import type { ItemService } from '@ai-personal/items';
import {
    Id,
    Item,
    ItemChangesQuery,
    ItemChildrenQuery,
    ItemContent,
    ItemCounts,
    ItemSearchQuery,
    ItemSubtree,
    ItemSubtreeQuery,
    pageOf,
} from '@ai-personal/shared';
import type { Repositories } from '@ai-personal/storage';
import { ToolDeniedError } from '@ai-personal/tools';
import { requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

const idParam = z.object({ id: Id });
const tags = ['items'];

const rootsRoute = createRoute({
    method: 'get',
    path: '/items/roots',
    tags,
    summary: 'Top-level categories of the knowledge map (syncs first when stale)',
    responses: { 200: json(pageOf(Item), 'Root categories'), ...authErrors },
});
const searchRoute = createRoute({
    method: 'get',
    path: '/items/search',
    tags,
    summary: 'Search items by title and summary, optionally under one item',
    request: { query: ItemSearchQuery },
    responses: { 200: json(pageOf(Item), 'Matches'), 400: problem('Invalid query'), ...authErrors },
});
const changesRoute = createRoute({
    method: 'get',
    path: '/items/changes',
    tags,
    summary: 'Items changed since a cursor, including deleted ones (deletedAt set)',
    request: { query: ItemChangesQuery },
    responses: { 200: json(pageOf(Item), 'Changes'), 400: problem('Invalid query'), ...authErrors },
});
const syncRoute = createRoute({
    method: 'post',
    path: '/items/sync',
    tags,
    summary: 'Sync all item providers now',
    responses: { 204: { description: 'Synced' }, ...authErrors },
});
const getRoute = createRoute({
    method: 'get',
    path: '/items/{id}',
    tags,
    summary: 'Get an item',
    request: { params: idParam },
    responses: { 200: json(Item, 'Item'), 404: problem('Not found'), ...authErrors },
});
const childrenRoute = createRoute({
    method: 'get',
    path: '/items/{id}/children',
    tags,
    summary: 'Direct children, cursor-paginated',
    request: { params: idParam, query: ItemChildrenQuery },
    responses: {
        200: json(pageOf(Item), 'Children'),
        400: problem('Invalid query'),
        404: problem('Not found'),
        ...authErrors,
    },
});
const ancestorsRoute = createRoute({
    method: 'get',
    path: '/items/{id}/ancestors',
    tags,
    summary: 'Ancestors from the root category down to the parent (breadcrumb)',
    request: { params: idParam },
    responses: { 200: json(pageOf(Item), 'Ancestors'), 404: problem('Not found'), ...authErrors },
});
const countsRoute = createRoute({
    method: 'get',
    path: '/items/{id}/counts',
    tags,
    summary: 'Children, descendants and descendants by type',
    request: { params: idParam },
    responses: { 200: json(ItemCounts, 'Counts'), 404: problem('Not found'), ...authErrors },
});
const subtreeRoute = createRoute({
    method: 'get',
    path: '/items/{id}/subtree',
    tags,
    summary: 'A subtree of limited depth (at most 3), as a flat list',
    request: { params: idParam, query: ItemSubtreeQuery },
    responses: {
        200: json(ItemSubtree, 'Subtree'),
        400: problem('Invalid query'),
        404: problem('Not found'),
        ...authErrors,
    },
});
const contentRoute = createRoute({
    method: 'get',
    path: '/items/{id}/content',
    tags,
    summary: 'Open an item; file-backed items are re-checked against the authorized folders (403 if outside)',
    request: { params: idParam },
    responses: {
        200: json(ItemContent, 'Content'),
        404: problem('Not found'),
        422: problem('The item cannot be read (for example a binary file)'),
        ...authErrors,
    },
});

export interface ItemRouteDeps {
    repos: Repositories;
    items: ItemService;
}

export function itemRoutes(deps: ItemRouteDeps) {
    const { repos, items } = deps;
    /**
     * 未删除的条目。记忆自 M2 PR 14 起有自己的提供者,可以在知识地图中浏览与打开(ADR 0007 第 5.8 节);
     * 条目搜索、变更流与给模型的 items.* 工具仍然不含记忆(模型通过 memory.* 工具检索,带渠道过滤)。
     */
    const live = (ownerId: string, id: string) => {
        const item = repos.items.get(ownerId, id);
        if (!item || item.deletedAt) throw notFound('Item');
        return item;
    };
    return router()
        .openapi(rootsRoute, async (c) => {
            const ownerId = requireOwner(c);
            await items.syncIfStale(ownerId);
            return c.json({ items: repos.items.roots(ownerId), nextCursor: null }, 200);
        })
        .openapi(searchRoute, (c) => {
            const ownerId = requireOwner(c);
            const query = c.req.valid('query');
            if (query.under) live(ownerId, query.under);
            return c.json({ items: repos.items.search(ownerId, query), nextCursor: null }, 200);
        })
        .openapi(changesRoute, (c) => c.json(repos.items.changes(requireOwner(c), c.req.valid('query')), 200))
        .openapi(syncRoute, async (c) => {
            await items.sync(requireOwner(c));
            return c.body(null, 204);
        })
        .openapi(getRoute, (c) => c.json(live(requireOwner(c), c.req.valid('param').id), 200))
        .openapi(childrenRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            live(ownerId, id);
            const { includeHidden, ...query } = c.req.valid('query');
            const page = repos.items.children(ownerId, id, query);
            // 默认视图隐藏 meta.hidden 的子项(记忆的「历史版本」);分页游标不变,本页可能少于 limit 条
            if (includeHidden) return c.json(page, 200);
            const visible = page.items.filter((i) => (i.meta as { hidden?: unknown } | null)?.hidden !== true);
            return c.json({ ...page, items: visible }, 200);
        })
        .openapi(ancestorsRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            live(ownerId, id);
            return c.json({ items: repos.items.ancestors(ownerId, id), nextCursor: null }, 200);
        })
        .openapi(countsRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            live(ownerId, id);
            return c.json(repos.items.counts(ownerId, id)!, 200);
        })
        .openapi(subtreeRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            live(ownerId, id);
            const { depth, limitPerNode } = c.req.valid('query');
            return c.json(repos.items.subtree(ownerId, id, depth, limitPerNode), 200);
        })
        .openapi(contentRoute, async (c) => {
            const ownerId = requireOwner(c);
            const item = live(ownerId, c.req.valid('param').id);
            try {
                return c.json(await items.open(ownerId, item), 200);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (error instanceof ToolDeniedError) {
                    // 与文件工具相同:越权按「拒绝」写审计(ADR 0012 第 5 节)
                    repos.audit.append(ownerId, {
                        action: 'tool-call',
                        toolName: 'items.content',
                        risk: 'read',
                        callId: null,
                        runId: null,
                        sessionId: null,
                        decision: 'denied',
                        outcome: 'not_run',
                        summary: `Open ${item.title}`,
                        inputDigest: JSON.stringify({ id: item.id }),
                        error: message.slice(0, 2000),
                    });
                    throw new ApiError(403, 'forbidden', 'Forbidden', message);
                }
                throw new ApiError(422, 'validation_failed', 'Unprocessable Content', message);
            }
        });
}
