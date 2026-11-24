// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    bubbleBox,
    expandedId,
    firstSentence,
    hitPath,
    type LabelCandidate,
    MAX_VISIBLE_NODES,
    orderNodes,
    pickNode,
    placeLabels,
} from './knowledge-model.js';

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

describe('placeLabels', () => {
    const measure = (text: string) => text.length * 10;
    const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
    const cand = (id: string, x: number, y: number, text: string, priority = 0, always = false): LabelCandidate => ({
        id,
        text,
        x,
        y,
        align: 'left',
        priority,
        always,
    });

    it('标签不压在气泡上:放不下就不画', () => {
        const avoid = [bubbleBox({ x: 200, y: 200 }, { w: 200, h: 40 })];
        const out = placeLabels([cand('a', 150, 170, '用户在一家做物流软件的公司')], measure, avoid, short);
        expect(out).toEqual([]);
    });

    it('和更重要的标签重叠时先截短,还不行就跳过;悬停的总显示', () => {
        const out = placeLabels(
            [
                cand('low', 0, 0, '一二三四五六七八九十'),
                cand('high', 70, 0, '中心', 10),
                cand('hover', 0, 0, '悬停的节点', 0, true),
            ],
            measure,
            [],
            short,
        );
        const shown = Object.fromEntries(out.map((l) => [l.id, l.shown]));
        expect(shown.hover).toBe('悬停的节点');
        expect(shown.high).toBe('中心');
        expect(shown.low).toBeUndefined();
        const cut = placeLabels(
            [cand('b', 0, 0, '一二三四五六七八九十'), cand('c', 70, 0, '中心', 10)],
            measure,
            [],
            short,
        );
        expect(cut.find((l) => l.id === 'b')?.shown).toBe('一二三四五…');
    });

    it('右侧被占、左侧有空时换到节点左边显示(对齐随之互换);不给 flipX 时不换边', () => {
        // 节点在 x=200;右侧 [206, 306) 被更重要的标签占住
        const node = { ...cand('n', 206, 0, '一二三四五六七八'), flipX: 194 };
        const blocker = cand('big', 206, 0, '一二三四五六七八九十', 10);
        const out = placeLabels([blocker, node], measure, [], short);
        expect(out.find((l) => l.id === 'n')).toMatchObject({ x: 194, align: 'right', shown: '一二三四五六七八' });
        const noFlip = placeLabels([blocker, cand('n', 206, 0, '一二三四五六七八')], measure, [], short);
        expect(noFlip.find((l) => l.id === 'n')).toBeUndefined();
    });

    it('悬停 / 焦点的标签先试不压气泡的一侧', () => {
        const avoid = [{ x: 210, y: -20, w: 200, h: 40 }];
        const hover = { ...cand('h', 206, 0, '悬停', 0, true), flipX: 194 };
        expect(placeLabels([hover], measure, avoid, short)[0]).toMatchObject({ x: 194, align: 'right' });
        // 两边都压着时留在原来那侧
        const both = [{ x: 0, y: -20, w: 400, h: 40 }];
        expect(placeLabels([hover], measure, both, short)[0]).toMatchObject({ x: 206, align: 'left' });
    });
});
