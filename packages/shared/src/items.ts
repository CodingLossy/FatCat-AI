// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 条目索引(知识地图数据层,ADR 0003、ADR 0012)。
import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';
import { MAX_PAGE_LIMIT } from './pagination.js';

/** item_edges.rel 的取值:supersedes 与 forked_from 自 M2 起使用(ADR 0007 第 5.4 节)。 */
export const ItemRel = z.enum(['contains', 'mentions', 'derived', 'supersedes', 'forked_from']);
export type ItemRel = z.infer<typeof ItemRel>;

/**
 * 已知的 items.source(提供者 id);mail 自 M3 起使用(ADR 0016 第 8 节)。
 * Item.source 仍是字符串:以后新增提供者时,旧客户端不会因为不认识的值而解析失败。
 */
export const ItemSource = z.enum(['files', 'novels', 'sessions', 'memory', 'mail']);
export type ItemSource = z.infer<typeof ItemSource>;

export const ItemKind = z.enum(['category', 'content']);
export type ItemKind = z.infer<typeof ItemKind>;

export const Item = z.object({
    id: Id,
    kind: ItemKind,
    /** 如 files.root、files.folder、files.file、novel、novel.chapter、session。 */
    type: z.string(),
    /** 提供者 id(files、novels、sessions…)。 */
    source: z.string(),
    sourceRef: z.string().nullable(),
    title: z.string(),
    summary: z.string().nullable(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    /** 直接子项数(只计未删除的条目,沿 primary contains 边)。 */
    childCount: z.number().int().nonnegative(),
    /** 后代总数(同上)。 */
    descendantCount: z.number().int().nonnegative(),
    meta: z.record(z.string(), z.unknown()).nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    /** 只在 /items/changes 中可能不为 null。 */
    deletedAt: IsoDateTime.nullable(),
});
export type Item = z.infer<typeof Item>;

export const ItemSort = z.enum(['position', 'title', 'updatedAt']);
export type ItemSort = z.infer<typeof ItemSort>;

export const ItemChildrenQuery = z.object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(50),
    type: z.string().min(1).max(100).optional(),
    kind: ItemKind.optional(),
    sort: ItemSort.default('position'),
    /**
     * 是否包含 meta.hidden 为 true 的子项(例如记忆的「历史版本」类别);默认不包含。
     * 自 M2 PR 14 起提供(ADR 0007 第 5.8 节)。
     */
    includeHidden: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
});
export type ItemChildrenQuery = z.input<typeof ItemChildrenQuery>;

export const ItemCounts = z.object({
    children: z.number().int().nonnegative(),
    descendants: z.number().int().nonnegative(),
    byType: z.record(z.string(), z.number().int().nonnegative()),
});
export type ItemCounts = z.infer<typeof ItemCounts>;

/** 有限深度子树:扁平列表,按深度与位置排列(避免递归 schema,便于生成 OpenAPI)。 */
export const ItemSubtree = z.object({
    nodes: z.array(z.object({ item: Item, parentId: Id, depth: z.number().int().min(1).max(3) })),
});
export type ItemSubtree = z.infer<typeof ItemSubtree>;

export const ItemSubtreeQuery = z.object({
    depth: z.coerce.number().int().min(1).max(3).default(2),
    limitPerNode: z.coerce.number().int().min(1).max(50).default(20),
});
export type ItemSubtreeQuery = z.infer<typeof ItemSubtreeQuery>;

export const ItemSearchQuery = z.object({
    q: z.string().trim().min(1).max(200),
    type: z.string().min(1).max(100).optional(),
    /** 只在这个条目的子树内搜索。 */
    under: Id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ItemSearchQuery = z.infer<typeof ItemSearchQuery>;

export const ItemChangesQuery = z.object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(100),
});
export type ItemChangesQuery = z.infer<typeof ItemChangesQuery>;

/** GET /items/{id}/content:由提供者读取的正文。 */
export const ItemContent = z.object({
    format: z.enum(['text']),
    content: z.string(),
    truncated: z.boolean(),
});
export type ItemContent = z.infer<typeof ItemContent>;
