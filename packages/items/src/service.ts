// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 条目服务:按需同步各提供者,打开条目时交给对应提供者(ADR 0012 第 4、5 节)。
import type { Item, ItemContent } from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import { filesProvider } from './files.js';
import { novelsProvider } from './novels.js';
import type { ItemProvider } from './provider.js';
import { sessionsProvider } from './sessions.js';

/** GET /items/roots 时距离上次同步超过这个时间就先同步。 */
export const SYNC_INTERVAL_MS = 60_000;

export interface ItemServiceOptions {
    repos: Repositories;
    providers?: ItemProvider[];
    now?: () => number;
    onError?: (error: unknown, context: { provider: string }) => void;
    /** 每次同步结束后调用(例如在后台更新知识库,ADR 0015)。 */
    onSynced?: (ownerId: string) => void;
}

export function createItemService(options: ItemServiceOptions) {
    const { repos } = options;
    const providers = options.providers ?? [filesProvider, novelsProvider, sessionsProvider];
    const now = options.now ?? Date.now;
    const lastSync = new Map<string, number>();
    const running = new Map<string, Promise<void>>();

    const rootsOf = (ownerId: string) =>
        repos.fsRoots.list(ownerId).map((r) => ({ id: r.id, path: r.path, label: r.label }));

    async function syncAll(ownerId: string): Promise<void> {
        const roots = rootsOf(ownerId);
        for (const provider of providers) {
            try {
                await provider.sync({
                    ownerId,
                    repos,
                    roots,
                    upsert: (input) => repos.items.upsert(ownerId, { ...input, source: provider.id }),
                    removeMissing: (parentId, keep) => repos.items.removeMissing(ownerId, parentId, provider.id, keep),
                });
            } catch (error) {
                // 一个提供者失败不影响其他提供者
                options.onError?.(error, { provider: provider.id });
            }
        }
        lastSync.set(ownerId, now());
        options.onSynced?.(ownerId);
    }

    /** 同一 owner 同时只运行一次同步;正在同步时等待它结束。 */
    function sync(ownerId: string): Promise<void> {
        const current = running.get(ownerId);
        if (current) return current;
        const promise = syncAll(ownerId).finally(() => running.delete(ownerId));
        running.set(ownerId, promise);
        return promise;
    }

    return {
        sync,
        /** 授权目录增删之后:下一次读取前重新同步。 */
        invalidate(ownerId: string): void {
            lastSync.delete(ownerId);
        },
        /** 超过同步间隔时先同步。 */
        async syncIfStale(ownerId: string): Promise<void> {
            const last = lastSync.get(ownerId);
            if (last === undefined || now() - last >= SYNC_INTERVAL_MS) await sync(ownerId);
        },
        /** 打开条目:由提供者读取;文件类条目会重新校验路径,越权时抛出 ToolDeniedError。 */
        async open(ownerId: string, item: Item): Promise<ItemContent> {
            const provider = providers.find((p) => p.id === item.source);
            if (!provider) throw new Error(`no provider can open items from ${item.source}`);
            return provider.open(item, { ownerId, repos, roots: rootsOf(ownerId).map((r) => r.path) });
        },
    };
}

export type ItemService = ReturnType<typeof createItemService>;
