// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { AgentEvent } from './events.js';
import { ItemRel } from './items.js';
import {
    MemoryFeedbackInput,
    MemoryRetrieveInput,
    MemorySaveInput,
    MemoryWriteInput,
    MemoryWriteResult,
    RetrievedMemory,
    Tier,
} from './memory.js';

const ID = '01JC0000000000000000000000';

describe('记忆 v2 契约(ADR 0007 第 5.4 节)', () => {
    it('MemoryWriteInput 兼容 MemorySaveInput,并增加 v2 字段;键与决策状态受限', () => {
        const save = { text: '用户住在杭州', entityKey: 'user.location.city' };
        expect(MemorySaveInput.parse(save)).toEqual(MemoryWriteInput.parse(save));
        expect(MemoryWriteInput.parse({ ...save, importance: 0.9, decisionState: 'accepted' })).toMatchObject({
            memType: 'semantic',
            importance: 0.9,
        });
        expect(MemoryWriteInput.safeParse({ ...save, entityKey: 'User City' }).success).toBe(false);
        expect(MemoryWriteInput.safeParse({ ...save, decisionState: 'superseded' }).success).toBe(false);
        expect(MemoryWriteInput.safeParse({ ...save, validFrom: 'yesterday' }).success).toBe(false);
        expect(MemoryWriteResult.parse({ outcome: 'conflicted', id: ID, conflictId: ID })).toMatchObject({
            conflictId: ID,
        });
    });

    it('检索输入的默认值与上限;检索结果、反馈、分层', () => {
        expect(MemoryRetrieveInput.parse({ query: '我住哪' })).toEqual({
            query: '我住哪',
            includeSuperseded: false,
            includeArchive: false,
            tokenBudget: 1200,
            limit: 12,
        });
        expect(MemoryRetrieveInput.safeParse({ query: 'x', tokenBudget: 5000 }).success).toBe(false);
        expect(
            RetrievedMemory.safeParse({
                id: ID,
                text: '用户住在上海',
                memType: 'semantic',
                status: 'active',
                tier: 'cold',
                confidence: 0.86,
                qualifier: 'possibly_stale',
                origin: 'user_explicit',
                lastConfirmedAt: null,
                score: 0.4,
                channels: ['fts', 'vec'],
            }).success,
        ).toBe(true);
        expect(MemoryFeedbackInput.safeParse({ id: ID, signal: 'wrong', correction: '上海' }).success).toBe(true);
        expect(MemoryFeedbackInput.safeParse({ id: ID, signal: 'meh' }).success).toBe(false);
        expect(Tier.options).toEqual(['active', 'cold', 'archive']);
    });

    it('新的边类型与 memory-used 事件', () => {
        expect(ItemRel.options).toContain('supersedes');
        expect(ItemRel.options).toContain('forked_from');
        expect(AgentEvent.parse({ type: 'memory-used', runId: ID, ids: [ID] })).toEqual({
            type: 'memory-used',
            runId: ID,
            ids: [ID],
        });
    });
});
