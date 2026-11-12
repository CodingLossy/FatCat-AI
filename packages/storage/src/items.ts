// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 条目索引(ADR 0003、ADR 0012 第 1 节):upsert / 移动 / 软删除都在事务中沿祖先链维护计数;recount 用递归 CTE 校正。
// 计数只统计未删除的条目,只沿 primary contains 边。
import type { Item, ItemCounts, ItemKind, ItemSort } from '@fatcat-ai/shared';
import { z } from 'zod';
import { decodeCursor, encodeCursor, type Page } from './cursor.js';
import type { Connection } from './db.js';
import { StorageError } from './db.js';
import { newId } from './ids.js';

export class ItemCycleError extends StorageError {}

interface Row {
    id: string;
    kind: ItemKind;
    type: string;
    source: string;
    sourceRef: string | null;
    title: string;
    summary: string | null;
    icon: string | null;
    color: string | null;
    childCount: number;
    descendantCount: number;
    metaJson: string | null;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    position?: number | null;
}

const COLUMNS = `i.id, i.kind, i.type, i.source, i.source_ref AS sourceRef, i.title, i.summary, i.icon, i.color,
    i.child_count AS childCount, i.descendant_count AS descendantCount, i.meta AS metaJson,
    i.created_at AS createdAt, i.updated_at AS updatedAt, i.deleted_at AS deletedAt`;

/**
 * 从某个节点向下,默认展开能看到的内容条目数(ADR 0025):
 * kind 为 content,沿 primary contains 边,不进入 meta.hidden 的子树(记忆的「历史版本」)。
 * 分类节点本身不计数。现算,不另存一列,所以不需要迁移。
 */
const CONTENT_COUNT = `WITH RECURSIVE vis(id, hidden) AS (
    SELECT c.id, CASE WHEN json_extract(c.meta, '$.hidden') = 1 THEN 1 ELSE 0 END
    FROM item_edges e JOIN items c ON c.id = e.child_id
    WHERE e.parent_id = @root AND e.primary_edge = 1 AND e.rel = 'contains' AND c.deleted_at IS NULL
    UNION ALL
    SELECT c.id, CASE WHEN vis.hidden = 1 OR json_extract(c.meta, '$.hidden') = 1 THEN 1 ELSE 0 END
    FROM item_edges e JOIN vis ON e.parent_id = vis.id JOIN items c ON c.id = e.child_id
    WHERE e.primary_edge = 1 AND e.rel = 'contains' AND c.deleted_at IS NULL
)
SELECT count(*) AS n FROM vis JOIN items x ON x.id = vis.id WHERE vis.hidden = 0 AND x.kind = 'content'`;

function toItem(row: Row, contentCount = 0): Item {
    return {
        id: row.id,
        kind: row.kind,
        type: row.type,
        source: row.source,
        sourceRef: row.sourceRef,
        title: row.title,
        summary: row.summary,
        icon: row.icon,
        color: row.color,
        childCount: row.childCount,
        descendantCount: row.descendantCount,
        contentCount,
        meta: row.metaJson ? (JSON.parse(row.metaJson) as Record<string, unknown>) : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
    };
}

export interface ItemInput {
    source: string;
    sourceRef: string;
    kind: ItemKind;
    type: string;
    title: string;
    summary?: string | null;
    icon?: string | null;
    color?: string | null;
    meta?: Record<string, unknown> | null;
    /** primary 父项;null 表示顶层类别。 */
    parentId: string | null;
    position?: number | null;
}

const childCursor = z.object({ k: z.union([z.string(), z.number()]), id: z.string() });
const changeCursor = z.object({ t: z.string(), id: z.string() });

/** 递归 CTE:某个条目的全部未删除后代(沿 primary 边),含深度。 */
const DESCENDANTS = `WITH RECURSIVE d(id, depth) AS (
    SELECT e.child_id, 1 FROM item_edges e JOIN items c ON c.id = e.child_id
    WHERE e.parent_id = @root AND e.primary_edge = 1 AND c.deleted_at IS NULL
    UNION ALL
    SELECT e.child_id, d.depth + 1 FROM item_edges e JOIN d ON e.parent_id = d.id JOIN items c ON c.id = e.child_id
    WHERE e.primary_edge = 1 AND c.deleted_at IS NULL
)`;

export function createItemRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const iso = () => now().toISOString();

    const q = {
        get: sqlite.prepare<[string, string], Row>(`SELECT ${COLUMNS} FROM items i WHERE i.owner_id = ? AND i.id = ?`),
        bySource: sqlite.prepare<[string, string, string], Row>(
            `SELECT ${COLUMNS} FROM items i WHERE i.owner_id = ? AND i.source = ? AND i.source_ref = ?`,
        ),
        parentOf: sqlite.prepare<[string], { parentId: string }>(
            "SELECT parent_id AS parentId FROM item_edges WHERE child_id = ? AND primary_edge = 1 AND rel = 'contains'",
        ),
        insert: sqlite.prepare(
            `INSERT INTO items (id, owner_id, kind, type, source, source_ref, title, summary, icon, color, meta,
               created_at, updated_at)
             VALUES (@id, @ownerId, @kind, @type, @source, @sourceRef, @title, @summary, @icon, @color, @meta,
               @at, @at)`,
        ),
        update: sqlite.prepare(
            `UPDATE items SET kind = @kind, type = @type, title = @title, summary = @summary, icon = @icon,
               color = @color, meta = @meta, updated_at = @at, deleted_at = NULL
             WHERE id = @id`,
        ),
        insertEdge: sqlite.prepare(
            `INSERT INTO item_edges (parent_id, child_id, rel, position, primary_edge) VALUES (?, ?, 'contains', ?, 1)`,
        ),
        updateEdgePosition: sqlite.prepare(
            "UPDATE item_edges SET position = ? WHERE child_id = ? AND primary_edge = 1 AND rel = 'contains'",
        ),
        deleteEdge: sqlite.prepare(
            "DELETE FROM item_edges WHERE child_id = ? AND primary_edge = 1 AND rel = 'contains'",
        ),
        bump: sqlite.prepare(
            `UPDATE items SET child_count = child_count + @child, descendant_count = descendant_count + @desc
             WHERE id = @id`,
        ),
        ancestors: sqlite.prepare<{ id: string }, Row & { depth: number }>(
            `WITH RECURSIVE a(id, depth) AS (
               SELECT parent_id, 1 FROM item_edges WHERE child_id = @id AND primary_edge = 1 AND rel = 'contains'
               UNION ALL
               SELECT e.parent_id, a.depth + 1 FROM item_edges e JOIN a ON e.child_id = a.id
               WHERE e.primary_edge = 1 AND e.rel = 'contains'
             )
             SELECT ${COLUMNS}, a.depth FROM a JOIN items i ON i.id = a.id ORDER BY a.depth DESC`,
        ),
        descendantIds: sqlite.prepare<{ root: string }, { id: string }>(`${DESCENDANTS} SELECT id FROM d`),
        countsByType: sqlite.prepare<{ root: string }, { type: string; n: number }>(
            `${DESCENDANTS} SELECT i.type, count(*) AS n FROM d JOIN items i ON i.id = d.id GROUP BY i.type`,
        ),
        softDelete: sqlite.prepare<[string, string, string]>(
            'UPDATE items SET deleted_at = ?, updated_at = ?, child_count = 0, descendant_count = 0 WHERE id = ?',
        ),
        roots: sqlite.prepare<[string], Row>(
            `SELECT ${COLUMNS} FROM items i
             WHERE i.owner_id = ? AND i.kind = 'category' AND i.deleted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM item_edges e WHERE e.child_id = i.id AND e.primary_edge = 1)
             ORDER BY i.title, i.id`,
        ),
        childrenOfSource: sqlite.prepare<[string, string], { id: string; sourceRef: string }>(
            `SELECT i.id, i.source_ref AS sourceRef FROM item_edges e JOIN items i ON i.id = e.child_id
             WHERE e.parent_id = ? AND e.primary_edge = 1 AND i.source = ? AND i.deleted_at IS NULL`,
        ),
        changesFirst: sqlite.prepare<[string, number], Row>(
            `SELECT ${COLUMNS} FROM items i WHERE i.owner_id = ? AND i.source <> 'memory'
             ORDER BY i.updated_at, i.id LIMIT ?`,
        ),
        changesAfter: sqlite.prepare<[string, string, string, string, number], Row>(
            `SELECT ${COLUMNS} FROM items i WHERE i.owner_id = ? AND i.source <> 'memory'
               AND (i.updated_at > ? OR (i.updated_at = ? AND i.id > ?))
             ORDER BY i.updated_at, i.id LIMIT ?`,
        ),
        allIds: sqlite.prepare<[string], { id: string; childCount: number; descendantCount: number }>(
            `SELECT id, child_count AS childCount, descendant_count AS descendantCount FROM items
             WHERE owner_id = ? AND deleted_at IS NULL`,
        ),
        realCounts: sqlite.prepare<{ root: string }, { children: number; descendants: number }>(
            `${DESCENDANTS} SELECT coalesce(sum(depth = 1), 0) AS children, count(*) AS descendants FROM d`,
        ),
        setCounts: sqlite.prepare<[number, number, string]>(
            'UPDATE items SET child_count = ?, descendant_count = ? WHERE id = ?',
        ),
        contentOf: sqlite.prepare<{ root: string }, { n: number }>(CONTENT_COUNT),
    };

    function contentCount(id: string): number {
        return q.contentOf.get({ root: id })?.n ?? 0;
    }

    /** counts 只在知识地图要显示数字的读路径上打开。同步和属性测试会大量按 source 取条目,每次都递归数一遍会超时。 */
    function present(row: Row, counts = false): Item {
        return toItem(row, counts ? contentCount(row.id) : 0);
    }

    function get(ownerId: string, id: string): Item | null {
        const row = q.get.get(ownerId, id);
        return row ? present(row, true) : null;
    }

    /** 沿祖先链调整计数:父项 child_count 加 child,父项及所有祖先 descendant_count 加 desc。 */
    function adjustAncestors(parentId: string | null, child: number, desc: number): void {
        if (!parentId) return;
        q.bump.run({ id: parentId, child, desc });
        for (const a of q.ancestors.all({ id: parentId })) q.bump.run({ id: a.id, child: 0, desc });
    }

    function isAncestorOrSelf(candidate: string, of: string): boolean {
        if (candidate === of) return true;
        return q.ancestors.all({ id: of }).some((a) => a.id === candidate);
    }

    /**
     * 新建或更新一个条目(按 owner + source + sourceRef 识别)。父项变化时移动,并检测环;
     * 已软删除的条目被恢复(计数按新建处理,子项随后由同步逐个恢复)。
     */
    function upsert(ownerId: string, input: ItemInput): Item {
        return sqlite.transaction(() => {
            if (input.parentId) {
                const parent = q.get.get(ownerId, input.parentId);
                if (!parent || parent.deletedAt) throw new StorageError('the parent item does not exist');
            }
            const at = iso();
            const fields = {
                kind: input.kind,
                type: input.type,
                title: input.title,
                summary: input.summary ?? null,
                icon: input.icon ?? null,
                color: input.color ?? null,
                meta: input.meta ? JSON.stringify(input.meta) : null,
                at,
            };
            const existing = q.bySource.get(ownerId, input.source, input.sourceRef);
            if (!existing) {
                const id = newId(now());
                q.insert.run({ id, ownerId, source: input.source, sourceRef: input.sourceRef, ...fields });
                if (input.parentId) {
                    q.insertEdge.run(input.parentId, id, input.position ?? null);
                    adjustAncestors(input.parentId, 1, 1);
                }
                return present(q.get.get(ownerId, id)!);
            }

            const wasDeleted = existing.deletedAt !== null;
            const oldParent = q.parentOf.get(existing.id)?.parentId ?? null;
            const size = 1 + existing.descendantCount;
            q.update.run({ id: existing.id, ...fields });
            if (oldParent !== input.parentId) {
                if (input.parentId && isAncestorOrSelf(existing.id, input.parentId)) {
                    throw new ItemCycleError('an item cannot be moved under itself or its descendants');
                }
                if (oldParent) {
                    q.deleteEdge.run(existing.id);
                    if (!wasDeleted) adjustAncestors(oldParent, -1, -size);
                }
                if (input.parentId) {
                    q.insertEdge.run(input.parentId, existing.id, input.position ?? null);
                    adjustAncestors(input.parentId, 1, wasDeleted ? 1 : size);
                }
            } else {
                if (input.parentId) q.updateEdgePosition.run(input.position ?? null, existing.id);
                if (wasDeleted) adjustAncestors(input.parentId, 1, 1);
            }
            return present(q.get.get(ownerId, existing.id)!);
        })();
    }

    function children(
        ownerId: string,
        parentId: string,
        page: {
            cursor?: string | undefined;
            limit: number;
            type?: string | undefined;
            kind?: ItemKind | undefined;
            sort: ItemSort;
        },
    ): Page<Item> {
        // 排序键与 id 组成游标;position 为空的排在最后
        const key =
            page.sort === 'title'
                ? 'i.title'
                : page.sort === 'updatedAt'
                  ? 'i.updated_at'
                  : 'coalesce(e.position, 2147483647)';
        const dir = page.sort === 'updatedAt' ? 'DESC' : 'ASC';
        const cmp = dir === 'ASC' ? '>' : '<';
        const after = page.cursor ? decodeCursor(page.cursor, childCursor) : null;
        const where = [
            'e.parent_id = @parentId',
            'e.primary_edge = 1',
            'i.owner_id = @ownerId',
            'i.deleted_at IS NULL',
            ...(page.type ? ['i.type = @type'] : []),
            ...(page.kind ? ['i.kind = @kind'] : []),
            ...(after ? [`(${key} ${cmp} @k OR (${key} = @k AND i.id ${cmp} @id))`] : []),
        ].join(' AND ');
        const rows = sqlite
            .prepare<Record<string, unknown>, Row & { k: string | number }>(
                `SELECT ${COLUMNS}, ${key} AS k FROM item_edges e JOIN items i ON i.id = e.child_id
                     WHERE ${where} ORDER BY ${key} ${dir}, i.id ${dir} LIMIT @limit`,
            )
            .all({
                parentId,
                ownerId,
                type: page.type,
                kind: page.kind,
                k: after?.k,
                id: after?.id,
                limit: page.limit + 1,
            });
        const items = rows.slice(0, page.limit);
        const last = items.at(-1);
        return {
            items: items.map((row) => present(row, true)),
            nextCursor: rows.length > page.limit && last ? encodeCursor({ k: last.k, id: last.id }) : null,
        };
    }

    /** 软删除整棵子树;计数沿祖先链扣减(ADR 0012 第 1 节)。 */
    function softDelete(ownerId: string, id: string): boolean {
        return sqlite.transaction(() => {
            const row = q.get.get(ownerId, id);
            if (!row || row.deletedAt) return false;
            const at = iso();
            const parent = q.parentOf.get(id)?.parentId ?? null;
            const ids = q.descendantIds.all({ root: id }).map((d) => d.id);
            for (const d of ids) q.softDelete.run(at, at, d);
            q.softDelete.run(at, at, id);
            adjustAncestors(parent, -1, -(1 + row.descendantCount));
            return true;
        })();
    }

    /**
     * 改变已有条目的 primary 父项(没有 source_ref 的条目也可以,例如记忆);parentId 为 null 时从树上摘下。
     * 沿新旧两条祖先链调整计数,并检测环(ADR 0007 第 5.2 节)。
     */
    function attach(ownerId: string, id: string, parentId: string | null, position: number | null = null): void {
        sqlite.transaction(() => {
            const row = q.get.get(ownerId, id);
            if (!row) throw new StorageError('the item does not exist');
            if (parentId) {
                const parent = q.get.get(ownerId, parentId);
                if (!parent || parent.deletedAt) throw new StorageError('the parent item does not exist');
                if (isAncestorOrSelf(id, parentId)) {
                    throw new ItemCycleError('an item cannot be moved under itself or its descendants');
                }
            }
            const oldParent = q.parentOf.get(id)?.parentId ?? null;
            if (oldParent === parentId) return;
            const size = row.deletedAt ? 0 : 1 + row.descendantCount;
            if (oldParent) {
                q.deleteEdge.run(id);
                if (size) adjustAncestors(oldParent, -1, -size);
            }
            if (parentId) {
                q.insertEdge.run(parentId, id, position);
                if (size) adjustAncestors(parentId, 1, size);
            }
        })();
    }

    return {
        get,
        attach,
        bySource(ownerId: string, source: string, sourceRef: string): Item | null {
            const row = q.bySource.get(ownerId, source, sourceRef);
            return row ? present(row) : null;
        },
        upsert,
        softDelete,
        /** 同步用:父项下某个来源的现存子项中,不在 keep 里的一律软删除;返回删除的条数。 */
        removeMissing(ownerId: string, parentId: string, source: string, keep: ReadonlySet<string>): number {
            let removed = 0;
            for (const c of q.childrenOfSource.all(parentId, source)) {
                if (!keep.has(c.sourceRef) && softDelete(ownerId, c.id)) removed++;
            }
            return removed;
        },
        roots(ownerId: string): Item[] {
            return q.roots.all(ownerId).map((row) => present(row, true));
        },
        parentId(id: string): string | null {
            return q.parentOf.get(id)?.parentId ?? null;
        },
        /** 祖先链,根在前,不含自身。 */
        ancestors(ownerId: string, id: string): Item[] {
            if (!q.get.get(ownerId, id)) return [];
            return q.ancestors.all({ id }).map((row) => present(row));
        },
        children,
        counts(ownerId: string, id: string): ItemCounts | null {
            const row = q.get.get(ownerId, id);
            if (!row || row.deletedAt) return null;
            const byType: Record<string, number> = {};
            for (const r of q.countsByType.all({ root: id })) byType[r.type] = r.n;
            return { children: row.childCount, descendants: row.descendantCount, byType };
        },
        /** 有限深度子树(扁平列表),每个节点最多 limitPerNode 个子项。 */
        subtree(ownerId: string, id: string, depth: number, limitPerNode: number) {
            const nodes: { item: Item; parentId: string; depth: number }[] = [];
            let frontier = [id];
            for (let level = 1; level <= depth && frontier.length > 0; level++) {
                const next: string[] = [];
                for (const parentId of frontier) {
                    const page = children(ownerId, parentId, { limit: limitPerNode, sort: 'position' });
                    for (const item of page.items) {
                        nodes.push({ item, parentId, depth: level });
                        if (item.childCount > 0) next.push(item.id);
                    }
                }
                frontier = next;
            }
            return { nodes };
        },
        /** FTS(trigram,≥ 3 字符)或 LIKE 回退;under 限定在子树内。 */
        search(
            ownerId: string,
            query: { q: string; type?: string | undefined; under?: string | undefined; limit: number },
        ) {
            const words = query.q.split(/\s+/).filter((w) => w.length >= 3);
            const scope = query.under ? `${DESCENDANTS.replace('@root', '@under')} ` : '';
            const underFilter = query.under ? 'AND i.id IN (SELECT id FROM d)' : '';
            const typeFilter = query.type ? 'AND i.type = @type' : '';
            const base = `i.owner_id = @ownerId AND i.deleted_at IS NULL AND i.source <> 'memory' ${typeFilter} ${underFilter}`;
            const params = {
                ownerId,
                type: query.type,
                under: query.under,
                limit: query.limit,
                match: words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR '),
                like: `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
            };
            const sql = words.length
                ? `${scope}SELECT ${COLUMNS} FROM items_fts JOIN items i ON i.rowid = items_fts.rowid
                   WHERE items_fts MATCH @match AND ${base} ORDER BY bm25(items_fts) LIMIT @limit`
                : `${scope}SELECT ${COLUMNS} FROM items i WHERE (i.title LIKE @like ESCAPE '\\' OR i.summary LIKE @like ESCAPE '\\')
                   AND ${base} ORDER BY i.updated_at DESC LIMIT @limit`;
            return sqlite
                .prepare<Record<string, unknown>, Row>(sql)
                .all(params)
                .map((row) => present(row));
        },
        changes(ownerId: string, page: { cursor?: string | undefined; limit: number }): Page<Item> {
            const after = page.cursor ? decodeCursor(page.cursor, changeCursor) : null;
            const rows = after
                ? q.changesAfter.all(ownerId, after.t, after.t, after.id, page.limit + 1)
                : q.changesFirst.all(ownerId, page.limit + 1);
            const items = rows.slice(0, page.limit).map((row) => present(row));
            const last = items.at(-1);
            return {
                items,
                nextCursor: rows.length > page.limit && last ? encodeCursor({ t: last.updatedAt, id: last.id }) : null,
            };
        },
        /** 用递归 CTE 重新计算全部计数;返回修正的条数(ADR 0012 第 1 节)。 */
        recount(ownerId: string): number {
            return sqlite.transaction(() => {
                let fixed = 0;
                for (const row of q.allIds.all(ownerId)) {
                    const real = q.realCounts.get({ root: row.id })!;
                    if (real.children !== row.childCount || real.descendants !== row.descendantCount) {
                        q.setCounts.run(real.children, real.descendants, row.id);
                        fixed++;
                    }
                }
                return fixed;
            })();
        },
    };
}

export type ItemRepository = ReturnType<typeof createItemRepository>;
