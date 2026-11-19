// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 浏览器里的离线缓存实例:联网时后台追平 /sync,断网时界面从缓存读。IndexedDB 不可用(隐私模式等)时一切照常,只是没有离线缓存。
import { FatCatNetworkError } from '@fatcat-ai/client';
import type { Message, Session, Settings } from '@fatcat-ai/shared';
import { api } from './api.js';
import { type CacheStore, indexedDbStore, syncCache } from './offline-cache.js';

let store: CacheStore | null | undefined;
function getStore(): CacheStore | null {
    if (store === undefined) {
        try {
            store = typeof indexedDB === 'undefined' ? null : indexedDbStore();
        } catch {
            store = null;
        }
    }
    return store;
}

let inflight: Promise<void> | null = null;

/** 后台追平缓存;并发调用共用一次;任何错误都忽略(离线 / 未登录 / 存储不可用)。 */
export function refreshCache(): Promise<void> {
    const s = getStore();
    if (!s) return Promise.resolve();
    inflight ??= syncCache((q) => api.sync(q), s)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
            inflight = null;
        });
    return inflight;
}

const SETTINGS_KEY = 'fatcat.lastSettings';

/** 记住最近一次的界面设置(主题、语言等,不含密钥),离线启动时用来渲染界面。 */
export function rememberSettings(settings: Settings): void {
    try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        // 存不下就算了
    }
}

/** 离线启动:有记住的设置并且缓存里有会话,说明这台设备登录过,可以只读地显示缓存。 */
export async function offlineStartup(): Promise<Settings | null> {
    try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        if (!raw || (await cachedSessions()).length === 0) return null;
        return JSON.parse(raw) as Settings;
    } catch {
        return null;
    }
}

/** 登出、设备退出时调用:丢掉缓存的会话、消息和记住的设置。 */
export async function clearCache(): Promise<void> {
    try {
        window.localStorage.removeItem(SETTINGS_KEY);
    } catch {
        // 忽略
    }
    try {
        await getStore()?.clear();
    } catch {
        // 清不掉就算了:下次联网同步会覆盖
    }
}

/** 只有「连不上服务器」才回落到缓存;401、404 等服务器的明确回答照常显示。 */
export const isOffline = (error: unknown) => error instanceof FatCatNetworkError;

export async function cachedSessions(): Promise<Session[]> {
    return (
        (await getStore()
            ?.listSessions()
            .catch(() => [])) ?? []
    );
}

export async function cachedMessages(sessionId: string): Promise<Message[]> {
    return (
        (await getStore()
            ?.listMessages(sessionId)
            .catch(() => [])) ?? []
    );
}
