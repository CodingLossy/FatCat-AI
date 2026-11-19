// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 增量同步(ADR 0045 第 2 节):手机端用游标拉取会话、消息、条目的变化,删除以墓碑表示。
import { createRoute } from '@hono/zod-openapi';
import { type SyncChange, type SyncKind, SyncQuery, SyncResponse } from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import { requireOwner } from '../auth/middleware.js';
import { authErrors, json, problem, router } from './common.js';

const syncRoute = createRoute({
    method: 'get',
    path: '/sync',
    tags: ['sync'],
    summary: 'Changes to sessions, messages and items since a cursor (deletions are tombstones)',
    request: { query: SyncQuery },
    responses: { 200: json(SyncResponse, 'A batch of changes'), 400: problem('Invalid query'), ...authErrors },
});

export function syncRoutes(deps: { repos: Repositories }) {
    const { repos } = deps;
    return router().openapi(syncRoute, (c) => {
        const ownerId = requireOwner(c);
        const query = c.req.valid('query');
        const after = query.cursor ? Number(query.cursor) : 0;
        const kinds = (query.kinds?.split(',') ?? []) as SyncKind[];
        const rows = repos.sync.changesAfter(ownerId, after, query.limit, kinds);

        const changes: SyncChange[] = rows.map((row) => {
            const tombstone = (): SyncChange => ({
                kind: row.kind,
                id: row.entityId,
                deleted: true,
                changedAt: row.changedAt,
                ...(row.kind === 'message' && row.sessionId ? { sessionId: row.sessionId } : {}),
            });
            if (row.deleted) return tombstone();
            // 日志指向的实体已经不在(日志与删除之间的竞争):按墓碑处理
            if (row.kind === 'session') {
                const session = repos.sessions.get(ownerId, row.entityId);
                return session
                    ? { kind: 'session', id: row.entityId, deleted: false, changedAt: row.changedAt, session }
                    : tombstone();
            }
            if (row.kind === 'message') {
                const message = repos.messages.get(ownerId, row.entityId);
                return message
                    ? { kind: 'message', id: row.entityId, deleted: false, changedAt: row.changedAt, message }
                    : tombstone();
            }
            const item = repos.items.get(ownerId, row.entityId);
            return item
                ? { kind: 'item', id: row.entityId, deleted: false, changedAt: row.changedAt, item }
                : tombstone();
        });

        const last = rows.at(-1);
        return c.json(
            { changes, cursor: last ? String(last.seq) : String(after), hasMore: rows.length >= query.limit },
            200,
        );
    });
}
