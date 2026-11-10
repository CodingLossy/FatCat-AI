// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cjkBigrams } from './memory-read.js';
import type { NewMemory } from './memory.js';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';

let t: TestDb;
beforeEach(async () => {
    t = await createTestDb({ now: fakeClock().auto() });
});
afterEach(() => t.cleanup());

const fact = (text: string, over: Partial<NewMemory> = {}): NewMemory => ({
    text,
    memType: 'semantic',
    subtype: null,
    entityKey: null,
    cardinality: 'multi',
    value: null,
    domain: 'general',
    sensitivity: 0,
    confidence: 0.9,
    origin: 'user_explicit',
    ...over,
});

describe('memoryRead', () => {
    it('二字词去掉虚词与泛词', () => {
        expect(cjkBigrams('我还住在杭州吗?')).toEqual(['还住', '住在', '在杭', '杭州']);
        expect(cjkBigrams('我对什么过敏')).toEqual(['对什', '过敏']);
        expect(cjkBigrams('用户喜欢喝龙井')).toEqual(['户喜', '喜欢', '欢喝', '喝龙', '龙井']);
        expect(cjkBigrams('hello')).toEqual([]);
    });

    it('全文召回:FTS 在前,二字词 LIKE 接在后面;只取给定的状态', () => {
        const a = t.repos.memories.save(t.ownerId, fact('用户常住杭州')).id;
        const b = t.repos.memories.save(t.ownerId, fact('用户在杭州西湖边跑步')).id;
        const read = t.repos.memoryRead;
        expect(read.fts(t.ownerId, '常住杭州', ['active'], 10)).toEqual([a, b]);
        expect(read.fts(t.ownerId, '杭州', ['active'], 10).sort()).toEqual([a, b].sort());
        expect(read.fts(t.ownerId, '杭州', ['superseded'], 10)).toEqual([]);
        expect(read.fts(t.ownerId, '   ', ['active'], 10)).toEqual([]);
        expect(read.candidates(t.ownerId, [a])).toEqual([expect.objectContaining({ id: a, pinned: false })]);
        expect(read.candidates(t.ownerId, [])).toEqual([]);
    });

    it('图召回、出处摘录、访问计数与 digest 缓存', () => {
        const session = t.repos.sessions.create(t.ownerId);
        const user = t.repos.messages.append(t.ownerId, session.id, {
            role: 'user',
            parts: [{ type: 'text', text: '记住张三是我同事' }],
            status: 'complete',
        });
        const id = t.repos.memories.save(
            t.ownerId,
            fact('张三是用户的同事', { source: { sessionId: session.id, userMessageId: user.id } }),
        ).id;
        const person = t.repos.items.upsert(t.ownerId, {
            source: 'contacts',
            sourceRef: 'p1',
            kind: 'content',
            type: 'person',
            title: '张三',
            parentId: null,
        }).id;
        t.conn.sqlite
            .prepare("INSERT INTO item_edges (parent_id, child_id, rel) VALUES (?, ?, 'mentions')")
            .run(person, id);
        const read = t.repos.memoryRead;
        expect(read.graph(t.ownerId, '张三最近怎么样', [], ['active'], 10)).toEqual([id]);
        expect(read.graph(t.ownerId, '没有种子', [], ['active'], 10)).toEqual([]);
        expect(read.excerpt(id)).toEqual({
            sessionId: session.id,
            messageId: user.id,
            question: '记住张三是我同事',
            answer: '',
        });

        read.touch([id]);
        read.touch([]);
        const row = t.conn.sqlite
            .prepare<[string], { n: number; at: string | null }>(
                'SELECT access_count AS n, last_accessed_at AS at FROM memory_facts WHERE item_id = ?',
            )
            .get(id)!;
        expect(row.n).toBe(1);
        expect(row.at).toBeTruthy();

        expect(read.getDigest(t.ownerId)).toBeNull();
        read.putDigest(t.ownerId, { body: 'x', tokenEstimate: 1, ids: [id], builtAt: '2026-11-05T00:00:00.000Z' });
        expect(read.getDigest(t.ownerId)).toEqual({
            body: 'x',
            tokenEstimate: 1,
            ids: [id],
            builtAt: '2026-11-05T00:00:00.000Z',
        });
        expect(read.countOpenConflicts(t.ownerId)).toBe(0);
        expect(read.openConflicts(t.ownerId, 3)).toEqual([]);
    });
});
