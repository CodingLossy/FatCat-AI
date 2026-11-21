// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { expandedId, firstSentence, hitPath, MAX_VISIBLE_NODES, orderNodes, pickNode } from './knowledge-model.js';

describe('knowledge model', () => {
    it('第一句:中文句号直接断开,英文要后跟空白,超长截断', () => {
        expect(firstSentence('用户喜欢喝无糖乌龙茶。每天下午一杯。')).toBe('用户喜欢喝无糖乌龙茶。');
        expect(firstSentence('Version 3.5 is out. More later.')).toBe('Version 3.5 is out.');
        expect(firstSentence('a'.repeat(200), 10)).toBe(`${'a'.repeat(9)}…`);
    });

    it('置顶排前,一屏最多 300 个;命中路径包含祖先', () => {
        const nodes = Array.from({ length: 400 }, (_, i) => ({
            id: String(i),
            label: String(i),
            kind: 'leaf' as const,
            pinned: i === 350,
        }));
        const out = orderNodes(nodes);
        expect(out).toHaveLength(MAX_VISIBLE_NODES);
        expect(out[0]?.id).toBe('350');
        expect([...hitPath([{ id: 'm:1', ancestors: ['t:semantic'] }])]).toEqual(['m:1', 't:semantic']);
        expect(expandedId({ path: [{ id: 'a', label: 'A' }] })).toBe('a');
        expect(expandedId({ path: [] })).toBeNull();
    });

    it('拾取最近且在半径内的节点', () => {
        const nodes = [
            { id: 'a', x: 10, y: 10, r: 5 },
            { id: 'b', x: 30, y: 10, r: 5 },
        ];
        expect(pickNode(nodes, 12, 11)).toBe('a');
        expect(pickNode(nodes, 100, 100)).toBeNull();
    });
});
