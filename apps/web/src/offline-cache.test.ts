// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Message, Session, SyncChange, SyncResponse } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { type CacheBatch, type CacheStore, syncCache } from './offline-cache.js';

function memoryStore(): CacheStore & { batches: number } {
    let cursor: string | undefined;
    const sessions = new Map<string, Session>();
    const messages = new Map<string, Message>();
    const self = {
        batches: 0,
        getCursor: () => Promise.resolve(cursor),
        applyBatch(b: CacheBatch) {
            self.batches += 1;
            for (const s of b.sessions) sessions.set(s.id, s);
            for (const m of b.messages) messages.set(m.id, m);
            for (const m of b.deletedMessages) messages.delete(m.id);
            for (const id of b.deletedSessions) {
                sessions.delete(id);
                for (const m of [...messages.values()]) if (m.sessionId === id) messages.delete(m.id);
            }
            cursor = b.cursor;
            return Promise.resolve();
        },
        listSessions: () => Promise.resolve([...sessions.values()]),
        listMessages: (id: string) => Promise.resolve([...messages.values()].filter((m) => m.sessionId === id)),
        clear() {
            cursor = undefined;
            sessions.clear();
            messages.clear();
            return Promise.resolve();
        },
    };
    return self;
}

const session = (id: string) => ({ id, title: id }) as unknown as Session;
const message = (id: string, sessionId: string) => ({ id, sessionId, seq: 1 }) as unknown as Message;
const live = (kind: 'session' | 'message', value: Session | Message): SyncChange =>
    ({ kind, id: value.id, deleted: false, changedAt: 't', [kind]: value }) as unknown as SyncChange;
const gone = (kind: 'session' | 'message', id: string, sessionId?: string): SyncChange =>
    ({ kind, id, deleted: true, changedAt: 't', ...(sessionId ? { sessionId } : {}) }) as SyncChange;

describe('syncCache', () => {
    it('分批拉到追平,游标随批次保存;墓碑删除缓存里的会话及其消息;出错后从游标继续', async () => {
        const store = memoryStore();
        const pages: SyncResponse[] = [
            {
                changes: [live('session', session('S1')), live('message', message('M1', 'S1'))],
                cursor: '2',
                hasMore: true,
            },
            { changes: [live('session', session('S2'))], cursor: '3', hasMore: false },
        ];
        const seen: (string | undefined)[] = [];
        await syncCache((q) => {
            seen.push(q.cursor);
            return Promise.resolve(pages.shift()!);
        }, store);
        expect(seen).toEqual([undefined, '2']);
        expect((await store.listSessions()).map((s) => s.id).sort()).toEqual(['S1', 'S2']);
        expect(await store.getCursor()).toBe('3');

        // 第二轮:S1 被删除(带消息墓碑),然后网络出错
        let call = 0;
        await expect(
            syncCache((q) => {
                call += 1;
                expect(q.cursor).toBe(call === 1 ? '3' : '4');
                return call === 1
                    ? Promise.resolve({
                          changes: [gone('session', 'S1'), gone('message', 'M1', 'S1')],
                          cursor: '4',
                          hasMore: true,
                      })
                    : Promise.reject(new TypeError('offline'));
            }, store),
        ).rejects.toThrow('offline');
        expect((await store.listSessions()).map((s) => s.id)).toEqual(['S2']);
        expect(await store.listMessages('S1')).toEqual([]);
        expect(await store.getCursor()).toBe('4'); // 出错前已写入的批次保留
    });

    it('正在拉取时清空缓存:放行后的批次不会被写回,游标保持为空', async () => {
        const store = memoryStore();
        let release!: (r: SyncResponse) => void;
        let cancelled = false;
        const running = syncCache(
            () =>
                new Promise<SyncResponse>((resolve) => {
                    release = resolve;
                }),
            store,
            { isCancelled: () => cancelled },
        );
        await Promise.resolve();
        // 登出:先标记取消,再清空
        cancelled = true;
        await store.clear();
        release({ changes: [live('session', session('S1'))], cursor: '5', hasMore: true });
        expect(await running).toBe(0);
        expect(await store.listSessions()).toEqual([]);
        expect(await store.getCursor()).toBeUndefined();
        expect(store.batches).toBe(0);
    });
});
