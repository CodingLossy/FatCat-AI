// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('memories', () => {
    it('写入、读取、同文本合并(置信度提高)', () => {
        const { memories } = t.repos;
        const a = memories.save(t.ownerId, fact('用户常住杭州'));
        expect(a.outcome).toBe('created');
        const b = memories.save(t.ownerId, fact('用户常住杭州'));
        expect(b).toEqual({ outcome: 'merged', id: a.id });
        expect(memories.get(t.ownerId, a.id)?.confidence).toBeCloseTo(0.95);
        expect(memories.list(t.ownerId, 10)).toHaveLength(1);
    });

    it('单值 entity_key 更替:旧值标为 superseded,检索只返回新值', () => {
        const { memories } = t.repos;
        const city = { entityKey: 'user.location.city', cardinality: 'single' as const };
        const old = memories.save(t.ownerId, fact('用户常住杭州', city));
        const next = memories.save(t.ownerId, fact('用户已搬到上海居住', city));
        expect(next).toMatchObject({ outcome: 'superseded', supersededId: old.id });
        expect(memories.get(t.ownerId, old.id)?.status).toBe('superseded');
        expect(memories.search(t.ownerId, '杭州', { limit: 10 })).toEqual([]);
        expect(memories.search(t.ownerId, '上海', { limit: 10 }).map((m) => m.id)).toEqual([next.id]);
    });

    it('检索:3 字以上走 FTS,1–2 字回退 LIKE;FTS 语法字符不会报错', () => {
        const { memories } = t.repos;
        memories.save(t.ownerId, fact('用户常住杭州西湖区'));
        memories.save(t.ownerId, fact('The user prefers concise answers', { memType: 'procedural' }));
        expect(memories.search(t.ownerId, '杭州西湖', { limit: 5 })).toHaveLength(1);
        expect(memories.search(t.ownerId, '杭', { limit: 5 })).toHaveLength(1);
        expect(memories.search(t.ownerId, 'concise', { limit: 5, types: ['semantic'] })).toHaveLength(0);
        expect(memories.search(t.ownerId, 'concise', { limit: 5, types: ['procedural'] })).toHaveLength(1);
        expect(() => memories.search(t.ownerId, '"unbalanced AND (', { limit: 5 })).not.toThrow();
        expect(memories.search(t.ownerId, '100%', { limit: 5 })).toEqual([]);
    });

    it('编辑、撤回、删除(级联删除出处,FTS 同步)', () => {
        const { memories } = t.repos;
        const session = t.repos.sessions.create(t.ownerId);
        const m = memories.save(t.ownerId, fact('用户喜欢喝龙井茶', { source: { sessionId: session.id } }));
        expect(memories.update(t.ownerId, m.id, { text: '用户喜欢喝碧螺春茶', domain: 'life' })).toMatchObject({
            text: '用户喜欢喝碧螺春茶',
            domain: 'life',
        });
        expect(memories.search(t.ownerId, '碧螺春', { limit: 5 })).toHaveLength(1);
        memories.update(t.ownerId, m.id, { retract: true });
        expect(memories.search(t.ownerId, '碧螺春', { limit: 5 })).toHaveLength(0);
        expect(memories.delete(t.ownerId, m.id)).toBe(true);
        const count = (table: string) =>
            (t.conn.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
        expect(count('memory_facts')).toBe(0);
        expect(count('memory_sources')).toBe(0);
        expect(memories.delete(t.ownerId, m.id)).toBe(false);
    });
});

describe('summaries', () => {
    it('按 from_seq 顺序返回各段摘要;同一起点不能重复', () => {
        const session = t.repos.sessions.create(t.ownerId);
        expect(t.repos.summaries.list(session.id)).toEqual([]);
        t.repos.summaries.add(session.id, { fromSeq: 11, toSeq: 20, summary: 'b' });
        t.repos.summaries.add(session.id, { fromSeq: 1, toSeq: 10, summary: 'a' });
        expect(t.repos.summaries.list(session.id).map((x) => x.summary)).toEqual(['a', 'b']);
        expect(() => t.repos.summaries.add(session.id, { fromSeq: 1, toSeq: 5, summary: 'c' })).toThrow(/UNIQUE/);
    });
});
