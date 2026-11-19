// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 离线只读缓存(ADR 0045 第 2 节):用 /sync 把会话和最近的消息存到 IndexedDB,断网时还能看。
// 只缓存会话与消息(条目不缓存);写操作不排队(离线时发送、删除仍会失败并显示错误)。登出、或服务器答复未登录 / 设备已吊销时清空。
import type { Message, Session, SyncChange, SyncResponse } from '@fatcat-ai/shared';

/** 每个会话最多保留的最近消息条数。 */
export const MAX_CACHED_MESSAGES_PER_SESSION = 200;

export interface CacheBatch {
    sessions: Session[];
    messages: Message[];
    deletedSessions: string[];
    deletedMessages: { id: string; sessionId?: string | undefined }[];
    /** 与数据在同一个事务里保存,保证游标和数据一致。 */
    cursor: string;
}

export interface CacheStore {
    getCursor(): Promise<string | undefined>;
    applyBatch(batch: CacheBatch): Promise<void>;
    listSessions(): Promise<Session[]>;
    listMessages(sessionId: string): Promise<Message[]>;
    clear(): Promise<void>;
}

export function toBatch(changes: SyncChange[], cursor: string): CacheBatch {
    const batch: CacheBatch = { sessions: [], messages: [], deletedSessions: [], deletedMessages: [], cursor };
    for (const c of changes) {
        if (c.deleted) {
            if (c.kind === 'session') batch.deletedSessions.push(c.id);
            else if (c.kind === 'message') batch.deletedMessages.push({ id: c.id, sessionId: c.sessionId });
        } else if (c.kind === 'session') batch.sessions.push(c.session);
        else if (c.kind === 'message') batch.messages.push(c.message);
    }
    return batch;
}

export type SyncFetcher = (query: {
    cursor?: string | undefined;
    limit: number;
    kinds: ('session' | 'message')[];
}) => Promise<SyncResponse>;

/**
 * 拉到追平为止。出错(离线、401)时保留已经写入的批次,下次从游标继续。
 * isCancelled 为真(例如正在登出清缓存)时不再写入任何批次,避免清空之后又被写回。
 * 返回这一轮收到的变化条数。
 */
export async function syncCache(
    fetchChanges: SyncFetcher,
    store: CacheStore,
    options: { limit?: number; isCancelled?: () => boolean } = {},
): Promise<number> {
    const limit = options.limit ?? 200;
    const cancelled = options.isCancelled ?? (() => false);
    let cursor = await store.getCursor();
    let total = 0;
    for (;;) {
        if (cancelled()) return total;
        const res = await fetchChanges({ cursor, limit, kinds: ['session', 'message'] });
        if (cancelled()) return total;
        await store.applyBatch(toBatch(res.changes, res.cursor));
        total += res.changes.length;
        cursor = res.cursor;
        if (!res.hasMore) return total;
    }
}

// ---------------------------------------------------------------------------
// IndexedDB 实现
// ---------------------------------------------------------------------------

const DB_NAME = 'fatcat-cache';
const DB_VERSION = 1;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
}

export function indexedDbStore(factory: IDBFactory = indexedDB): CacheStore {
    let opened: Promise<IDBDatabase> | null = null;
    const open = () =>
        (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                db.createObjectStore('sessions', { keyPath: 'id' });
                db.createObjectStore('messages', { keyPath: 'id' }).createIndex('bySession', 'sessionId');
                db.createObjectStore('meta');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error ?? new Error('Cannot open IndexedDB'));
        }).catch((error: unknown) => {
            opened = null;
            throw error;
        }));

    /** 删除某个会话的全部消息 / 超出上限的旧消息。 */
    async function trim(tx: IDBTransaction, sessionId: string, keep: number): Promise<void> {
        const index = tx.objectStore('messages').index('bySession');
        const all = (await promisify(index.getAll(sessionId))) as Message[];
        if (all.length <= keep) return;
        all.sort((a, b) => a.seq - b.seq);
        for (const m of all.slice(0, all.length - keep)) tx.objectStore('messages').delete(m.id);
    }

    return {
        async getCursor() {
            const db = await open();
            const v = (await promisify(db.transaction('meta').objectStore('meta').get('cursor'))) as unknown;
            return typeof v === 'string' ? v : undefined;
        },
        async applyBatch(batch) {
            const db = await open();
            const tx = db.transaction(['sessions', 'messages', 'meta'], 'readwrite');
            const done = transactionDone(tx);
            const sessions = tx.objectStore('sessions');
            const messages = tx.objectStore('messages');
            for (const s of batch.sessions) sessions.put(s);
            for (const m of batch.messages) messages.put(m);
            for (const id of batch.deletedMessages) messages.delete(id.id);
            for (const id of batch.deletedSessions) {
                sessions.delete(id);
                const keys = (await promisify(messages.index('bySession').getAllKeys(id))) as IDBValidKey[];
                for (const k of keys) messages.delete(k);
            }
            for (const sessionId of new Set(batch.messages.map((m) => m.sessionId))) {
                await trim(tx, sessionId, MAX_CACHED_MESSAGES_PER_SESSION);
            }
            tx.objectStore('meta').put(batch.cursor, 'cursor');
            await done;
        },
        async listSessions() {
            const db = await open();
            const all = (await promisify(db.transaction('sessions').objectStore('sessions').getAll())) as Session[];
            return all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
        },
        async listMessages(sessionId) {
            const db = await open();
            const all = (await promisify(
                db.transaction('messages').objectStore('messages').index('bySession').getAll(sessionId),
            )) as Message[];
            return all.sort((a, b) => a.seq - b.seq);
        },
        async clear() {
            const db = await open();
            const tx = db.transaction(['sessions', 'messages', 'meta'], 'readwrite');
            const done = transactionDone(tx);
            for (const name of ['sessions', 'messages', 'meta'] as const) tx.objectStore(name).clear();
            await done;
        },
    };
}
