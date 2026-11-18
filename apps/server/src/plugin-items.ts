// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件的知识地图条目(ADR 0040 第 3.3 节):来源固定为 `plugin:<id>`,只能挂在插件声明的类别下;
// 条目来自两条路:插件调 fatcat/items.upsert 推送,或同步时主程序调 fatcat/items.roots / children 拉取;
// 打开条目时调 fatcat/items.open。每个插件最多 50,000 条,单条 meta ≤ 8 KiB(后者由消息 schema 保证)。
import type { ItemProvider, OpenContext, SyncContext } from '@fatcat-ai/items';
import type { Item, ItemContent, PluginItemNode, PluginPermissions } from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import { PluginQuotaError, type PluginRuntime, type PluginUpsertItem } from '@fatcat-ai/tools/plugins';

export const PLUGIN_ITEM_QUOTA = 50_000;
/** 一次同步最多从插件拉取的节点数与层数,避免一个插件把一次同步拖得太久。 */
const PULL_NODE_LIMIT = 2000;
const PULL_DEPTH_LIMIT = 3;
const PULL_PAGES_PER_PARENT = 5;
/** 插件正在运行时同步照常拉取;没有运行时,距上次拉取不到这个时间就不为了刷新去启动进程。 */
const PULL_INTERVAL_MS = 5 * 60_000;
const OPEN_CONTENT_CHARS = 60_000;

export const pluginSource = (pluginId: string): string => `plugin:${pluginId}`;
const categoryRef = (type: string): string => `category:${type}`;
const nodeRef = (id: string): string => `n:${id}`;

function pickTitle(text: { 'zh-CN'?: string | undefined; en?: string | undefined }, locale: string): string {
    return (locale === 'en' ? text.en : text['zh-CN']) ?? text.en ?? text['zh-CN'] ?? '';
}

function ensureCategory(
    repos: Repositories,
    ownerId: string,
    pluginId: string,
    category: { type: string; title: { 'zh-CN'?: string | undefined; en?: string | undefined } },
): Item {
    const locale = repos.settings.get(ownerId).locale ?? 'zh-CN';
    return repos.items.upsert(ownerId, {
        source: pluginSource(pluginId),
        sourceRef: categoryRef(category.type),
        kind: 'category',
        type: 'plugin',
        title: pickTitle(category.title, locale),
        parentId: null,
    });
}

/** 写入插件推来的条目(fatcat/items.upsert);类别已由运行时核对。超过配额时整批拒绝,什么都不写。 */
export function upsertPluginItems(
    repos: Repositories,
    ownerId: string,
    pluginId: string,
    granted: PluginPermissions,
    items: readonly PluginUpsertItem[],
): number {
    const source = pluginSource(pluginId);
    const fresh = [...new Set(items.map((item) => item.id))].filter(
        (id) => !repos.items.bySource(ownerId, source, nodeRef(id)),
    ).length;
    if (repos.items.countBySource(ownerId, source) + fresh > PLUGIN_ITEM_QUOTA) {
        throw new PluginQuotaError(`at most ${PLUGIN_ITEM_QUOTA} items per plugin`);
    }
    const categories = granted.items?.categories ?? [];
    // 两遍:第一遍写入全部条目;第二遍把「父项排在后面」的子项挂到正确的父项下(不要求插件按顺序返回)
    for (const pass of [1, 2]) {
        for (const item of items) {
            if (pass === 2 && !item.parentId) continue;
            const category = categories.find((c) => c.type === item.type);
            if (!category) continue;
            const top = ensureCategory(repos, ownerId, pluginId, category);
            const parent = item.parentId ? repos.items.bySource(ownerId, source, nodeRef(item.parentId)) : null;
            repos.items.upsert(ownerId, {
                source,
                sourceRef: nodeRef(item.id),
                kind: item.hasChildren ? 'category' : 'content',
                type: item.type,
                title: item.title,
                summary: item.summary ?? null,
                meta: item.meta ?? null,
                parentId: parent && !parent.deletedAt ? parent.id : top.id,
            });
        }
    }
    return items.length;
}

export interface PluginItemProviderOptions {
    repos: Repositories;
    pluginId: string;
    /** 已授权的类别(granted_json.items);不再有时提供者不再生效。 */
    categories: () => PluginPermissions['items'];
    runtime: () => Promise<PluginRuntime>;
    now?: () => number;
}

/** 把一个插件的条目登记进条目索引的提供者:同步 = 拉取,打开 = fatcat/items.open。 */
export function createPluginItemProvider(options: PluginItemProviderOptions): ItemProvider {
    const { repos, pluginId } = options;
    const source = pluginSource(pluginId);
    const now = options.now ?? Date.now;
    let lastPull = 0;

    return {
        id: source,
        async sync(ctx: SyncContext): Promise<void> {
            const categories = options.categories()?.categories ?? [];
            if (categories.length === 0) return;
            const runtime = await options.runtime();
            // 进程没在运行且刚拉过:不为了刷新去启动它(空闲停止之后的省资源)
            if (!runtime.isRunning(pluginId) && now() - lastPull < PULL_INTERVAL_MS) return;
            lastPull = now();
            let budget = PULL_NODE_LIMIT;
            for (const category of categories) {
                const top = ensureCategory(repos, ctx.ownerId, pluginId, category);
                const queue: { node: PluginItemNode; item: Item; depth: number }[] = [];
                const put = (node: PluginItemNode, parent: Item, depth: number): Item | null => {
                    if (budget <= 0 || repos.items.countBySource(ctx.ownerId, source) >= PLUGIN_ITEM_QUOTA) return null;
                    budget--;
                    const item = repos.items.upsert(ctx.ownerId, {
                        source,
                        sourceRef: nodeRef(node.id),
                        kind: node.hasChildren ? 'category' : 'content',
                        type: node.type,
                        title: node.title,
                        summary: node.summary ?? null,
                        meta: node.meta ?? null,
                        parentId: parent.id,
                    });
                    if (node.hasChildren && depth < PULL_DEPTH_LIMIT) queue.push({ node, item, depth });
                    return item;
                };
                const roots = await runtime.itemsRoots(ctx.ownerId, pluginId, category.type);
                for (const node of roots.items) {
                    if (node.type === category.type) put(node, top, 1);
                }
                // 下层:每个父项下的子项以插件这次返回的为准,不在里面的软删除;顶层不删,留给插件推送的条目
                while (queue.length > 0) {
                    const next = queue.shift()!;
                    const keep = new Set<string>();
                    let cursor: string | undefined;
                    for (let page = 0; page < PULL_PAGES_PER_PARENT; page++) {
                        const result = await runtime.itemsChildren(
                            ctx.ownerId,
                            pluginId,
                            category.type,
                            next.node.id,
                            cursor,
                        );
                        for (const child of result.items) {
                            if (put(child, next.item, next.depth + 1)) keep.add(nodeRef(child.id));
                        }
                        cursor = result.nextCursor;
                        if (!cursor) break;
                    }
                    if (!cursor && budget > 0) ctx.removeMissing(next.item.id, keep);
                }
            }
        },
        async open(item: Item, ctx: OpenContext): Promise<ItemContent> {
            if (item.kind === 'category' && item.type === 'plugin')
                return { format: 'text', content: item.title, truncated: false };
            if (!item.sourceRef?.startsWith('n:')) throw new Error('this item cannot be opened');
            const runtime = await options.runtime();
            const result = await runtime.itemsOpen(ctx.ownerId, pluginId, item.type, item.sourceRef.slice(2));
            const text = result.url ? `${result.content}\n\n${result.url}` : result.content;
            return {
                format: 'text',
                content: text.slice(0, OPEN_CONTENT_CHARS),
                truncated: text.length > OPEN_CONTENT_CHARS,
            };
        },
    };
}
