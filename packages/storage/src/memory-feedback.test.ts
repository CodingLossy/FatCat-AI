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

const city = (text: string, origin: NewMemory['origin'] = 'user_explicit', confidence = 0.9) =>
    fact(text, { entityKey: 'user.location.city', cardinality: 'single', domain: 'life', origin, confidence });

describe('记忆反馈、更替链与冲突处理(仓储)', () => {
    it('反馈立即生效;同一运行同一信号只计一次', () => {
        const m = t.repos.memories;
        const id = m.save(t.ownerId, fact('用户喜欢喝龙井')).id;
        expect(m.feedback(t.ownerId, id, 'helpful', { runId: id })).toBe('ok');
        expect(m.feedback(t.ownerId, id, 'helpful', { runId: id })).toBe('duplicate');
        expect(m.get(t.ownerId, id)?.confidence).toBeCloseTo(0.95);
        m.feedback(t.ownerId, id, 'stale');
        m.feedback(t.ownerId, id, 'stale');
        expect(m.get(t.ownerId, id)).toMatchObject({ tier: 'cold' });
        m.feedback(t.ownerId, id, 'wrong');
        expect(m.get(t.ownerId, id)?.status).toBe('retracted');
        expect(m.feedback(t.ownerId, '01M00000000000000000000000', 'helpful')).toBe('not_found');
    });

    it('replace 建立更替链;history 新 → 旧;sources', () => {
        const m = t.repos.memories;
        const session = t.repos.sessions.create(t.ownerId);
        const a = m.save(t.ownerId, { ...city('用户住在杭州'), source: { sessionId: session.id } }).id;
        const b = m.replace(t.ownerId, a, city('用户住在上海'))!;
        expect(b.outcome).toBe('superseded');
        const c = m.replace(t.ownerId, b.id, city('用户住在苏州'))!;
        expect(m.history(t.ownerId, b.id)?.map((x) => x.text)).toEqual([
            '用户住在苏州',
            '用户住在上海',
            '用户住在杭州',
        ]);
        expect(m.history(t.ownerId, 'missing')).toBeNull();
        expect(m.sources(t.ownerId, a)).toEqual([expect.objectContaining({ sessionId: session.id })]);
        // 已被更替的记录再被更正:单值键已有别的 active,按普通写入处理
        expect(m.replace(t.ownerId, a, city('用户住在南京'))?.outcome).toBe('superseded');
        expect(m.get(t.ownerId, c.id)?.status).toBe('superseded');
        expect(m.replace(t.ownerId, 'missing', city('x'))).toBeNull();
    });

    it('冲突:kept_b、both_valid、dismissed;重复处理返回 not_open', () => {
        const m = t.repos.memories;
        const conflict = (x: string, y: string) => {
            const key = { entityKey: `user.role.${x}`, cardinality: 'single' as const };
            m.save(t.ownerId, fact(x, key));
            return m.save(t.ownerId, fact(y, { ...key, origin: 'extracted', confidence: 0.6 }));
        };
        const one = conflict('后端工程师', '产品经理');
        if (one.outcome !== 'conflicted') throw new Error('expected a conflict');
        expect(m.resolveConflict(t.ownerId, one.conflictId, 'kept_b')).toBe('ok');
        expect(m.get(t.ownerId, one.id)?.status).toBe('active');
        expect(m.resolveConflict(t.ownerId, one.conflictId, 'kept_b')).toBe('not_open');
        expect(m.resolveConflict(t.ownerId, 'missing', 'kept_a')).toBe('not_found');

        const two = conflict('喜欢猫', '喜欢狗');
        if (two.outcome !== 'conflicted') throw new Error('expected a conflict');
        expect(m.resolveConflict(t.ownerId, two.conflictId, 'both_valid')).toBe('ok');
        expect(m.get(t.ownerId, two.id)).toMatchObject({ status: 'active', cardinality: 'multi' });

        const three = conflict('早起', '晚起');
        if (three.outcome !== 'conflicted') throw new Error('expected a conflict');
        expect(m.resolveConflict(t.ownerId, three.conflictId, 'dismissed')).toBe('ok');
        expect(m.get(t.ownerId, three.id)?.status).toBe('conflicted');
        expect(m.conflict(t.ownerId, three.conflictId)?.status).toBe('dismissed');
    });

    it('隔离区条目读取与删除', () => {
        const m = t.repos.memories;
        const id = m.quarantine(t.ownerId, { raw: { text: 'x' }, reason: 'schema_invalid' });
        expect(m.quarantineEntry(t.ownerId, id)).toMatchObject({ raw: { text: 'x' }, reason: 'schema_invalid' });
        expect(m.deleteQuarantine(t.ownerId, id)).toBe(true);
        expect(m.quarantineEntry(t.ownerId, id)).toBeNull();
    });
});
