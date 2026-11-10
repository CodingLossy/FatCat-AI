// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepositories } from './repos.js';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';
import { MAX_EMBED_ATTEMPTS, VECTOR_TABLE } from './embeddings.js';

let t: TestDb;
let clock: ReturnType<typeof fakeClock>;
beforeEach(async () => {
    clock = fakeClock();
    t = await createTestDb({ now: clock.now });
});
afterEach(() => t.cleanup());

const vec = (...xs: number[]) => Float32Array.from(xs);
const state = { profileId: null, model: 'm1', dimensions: 3 };

function item(ref: string) {
    return t.repos.items.upsert(t.ownerId, {
        source: 'test',
        sourceRef: ref,
        kind: 'content',
        type: 'test.leaf',
        title: ref,
        parentId: null,
    });
}

/** 入队并立即完成:向量按入队顺序给出。 */
function embedAll(vectors: Float32Array[], model = state.model) {
    const { embeddings } = t.repos;
    const jobs = embeddings.due(100);
    embeddings.complete(jobs, vectors, model);
}

const vecRows = () => (t.conn.sqlite.prepare(`SELECT count(*) AS n FROM ${VECTOR_TABLE}`).get() as { n: number }).n;

describe('嵌入队列与向量表', () => {
    it('没有向量表时不加载扩展;第一次嵌入按维度建表,检索按距离排序并过滤软删除的条目', () => {
        const { embeddings, items } = t.repos;
        expect(embeddings.extensionLoaded).toBe(false);
        expect(embeddings.search(t.ownerId, vec(1, 0, 0), 5)).toEqual([]);
        expect(embeddings.extensionLoaded).toBe(false);

        const a = item('a');
        const b = item('b');
        expect(embeddings.enqueue(t.ownerId, a.id, 0, '苹果')).toBe(true);
        expect(embeddings.enqueue(t.ownerId, b.id, 0, 'banana')).toBe(true);
        expect(embeddings.counts(t.ownerId)).toEqual({ queued: 2, failed: 0, embedded: 0 });
        expect(embeddings.ensureVectorTable(state)).toBe(true);
        expect(embeddings.extensionLoaded).toBe(true);
        embedAll([vec(1, 0, 0), vec(0, 1, 0)]);
        expect(embeddings.counts(t.ownerId)).toEqual({ queued: 0, failed: 0, embedded: 2 });

        const hits = embeddings.search(t.ownerId, vec(0.9, 0.1, 0), 5);
        expect(hits.map((h) => [h.itemId, h.text])).toEqual([
            [a.id, '苹果'],
            [b.id, 'banana'],
        ]);
        expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance);
        expect(embeddings.search('someone-else', vec(1, 0, 0), 5)).toEqual([]);

        items.softDelete(t.ownerId, a.id);
        expect(embeddings.search(t.ownerId, vec(1, 0, 0), 5).map((h) => h.itemId)).toEqual([b.id]);

        // 原文没变时不重新入队
        expect(embeddings.enqueue(t.ownerId, b.id, 0, 'banana')).toBe(false);
        // 原文变了:旧向量删除,重新入队
        expect(embeddings.enqueue(t.ownerId, b.id, 0, 'cherry')).toBe(true);
        expect(vecRows()).toBe(1);
    });

    it('条目硬删除时,队列、映射与向量行都被级联清除(外键 + 触发器)', () => {
        const { embeddings } = t.repos;
        const a = item('a');
        const b = item('b');
        embeddings.enqueue(t.ownerId, a.id, 0, 'x');
        embeddings.enqueue(t.ownerId, a.id, 1, 'y');
        embeddings.enqueue(t.ownerId, b.id, 0, 'z');
        embeddings.ensureVectorTable(state);
        embedAll([vec(1, 0, 0), vec(0, 1, 0), vec(0, 0, 1)]);
        embeddings.enqueue(t.ownerId, a.id, 2, 'pending');
        expect(vecRows()).toBe(3);

        t.conn.sqlite.prepare('DELETE FROM items WHERE id = ?').run(a.id);
        expect(vecRows()).toBe(1);
        expect(embeddings.counts(t.ownerId)).toEqual({ queued: 0, failed: 0, embedded: 1 });
        expect(embeddings.search(t.ownerId, vec(1, 0, 0), 5).map((h) => h.itemId)).toEqual([b.id]);
    });

    it('重新打开数据库时,已有向量表会自动加载扩展,删除仍然可用', () => {
        const { embeddings } = t.repos;
        const a = item('a');
        embeddings.enqueue(t.ownerId, a.id, 0, 'x');
        embeddings.ensureVectorTable(state);
        embedAll([vec(1, 0, 0)]);
        const reopened = createRepositories(t.conn, { now: clock.now });
        expect(reopened.embeddings.extensionLoaded).toBe(true);
    });

    it('模型或维度变化时要求重建;重建后原文重新入队,按新维度建表,检索正常', () => {
        const { embeddings } = t.repos;
        const a = item('a');
        const b = item('b');
        embeddings.enqueue(t.ownerId, a.id, 0, 'x');
        embeddings.enqueue(t.ownerId, b.id, 0, 'y');
        embeddings.ensureVectorTable(state);
        embedAll([vec(1, 0, 0), vec(0, 1, 0)]);

        expect(embeddings.ensureVectorTable({ ...state, dimensions: 2 })).toBe(false);
        expect(embeddings.ensureVectorTable({ ...state, model: 'm2' })).toBe(false);
        expect(embeddings.state()).toMatchObject({ model: 'm1', dimensions: 3 });

        expect(embeddings.rebuild()).toBe(2);
        expect(embeddings.vectorTableExists()).toBe(false);
        expect(embeddings.state()).toBeNull();
        expect(embeddings.counts(t.ownerId)).toEqual({ queued: 2, failed: 0, embedded: 0 });

        expect(embeddings.ensureVectorTable({ profileId: 'p2', model: 'm2', dimensions: 2 })).toBe(true);
        embedAll([vec(0, 1), vec(1, 0)], 'm2');
        expect(embeddings.search(t.ownerId, vec(0, 1), 1).map((h) => h.text)).toEqual(['x']);
        expect(() => embeddings.ensureVectorTable({ ...state, dimensions: 0 })).not.toThrow(); // 已有表:只比较
    });

    it('失败按次数退避,超过上限后不再自动重试,重建时重置;每日用量按天累计', () => {
        const { embeddings } = t.repos;
        embeddings.enqueue(t.ownerId, item('a').id, 0, 'x');
        for (let i = 0; i < MAX_EMBED_ATTEMPTS; i++) {
            const jobs = embeddings.due(10);
            expect(jobs).toHaveLength(1);
            embeddings.fail(jobs, `boom ${i}`);
            expect(embeddings.due(10)).toEqual([]);
            clock.tick(3_600_000);
        }
        expect(embeddings.counts(t.ownerId)).toEqual({ queued: 0, failed: 1, embedded: 0 });
        expect(embeddings.lastError(t.ownerId)).toBe(`boom ${MAX_EMBED_ATTEMPTS - 1}`);
        expect(embeddings.nextAttemptAt()).toBeNull();
        embeddings.rebuild();
        expect(embeddings.due(10)).toHaveLength(1);

        embeddings.addUsage(t.ownerId, '2026-11-03', 3);
        embeddings.addUsage(t.ownerId, '2026-11-03', 2);
        expect(embeddings.usage(t.ownerId, '2026-11-03')).toBe(5);
        expect(embeddings.usage(t.ownerId, '2026-11-04')).toBe(0);
    });
});
