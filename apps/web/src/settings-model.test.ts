// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SETTINGS_VIEW,
    SETTINGS_SECTIONS,
    inputShare,
    pushSample,
    resolveView,
    sparkPoints,
    sumUsage,
} from './settings-model.js';

describe('设置分区', () => {
    it('每个分区都有子项,子项 id 在分区内唯一;非法输入回到默认', () => {
        for (const s of SETTINGS_SECTIONS) {
            expect(s.items.length).toBeGreaterThan(0);
            expect(new Set(s.items.map((i) => i.id)).size).toBe(s.items.length);
        }
        expect(resolveView('nope', 'x')).toEqual(DEFAULT_SETTINGS_VIEW);
        expect(resolveView('tools', 'nope')).toEqual({ section: 'tools', item: 'mcp' });
        expect(resolveView('system', 'network')).toEqual({ section: 'system', item: 'network' });
    });
});

describe('Token 用量', () => {
    it('只累加有 usage 的消息;全 0 时没有占比(显示空状态)', () => {
        const totals = sumUsage([
            { usage: { inputTokens: 30, outputTokens: 10 } },
            { usage: null },
            {},
            { usage: { outputTokens: 60 } },
        ]);
        expect(totals).toEqual({ input: 30, output: 70 });
        expect(inputShare(totals)).toBeCloseTo(0.3);
        expect(inputShare(sumUsage([]))).toBeNull();
    });
});

describe('延迟折线', () => {
    it('少于 2 个样本不画线;样本只保留最近 N 个', () => {
        expect(sparkPoints([5], 100, 20)).toBeNull();
        expect(sparkPoints([5, 10], 100, 20)?.split(' ')).toHaveLength(2);
        expect(pushSample([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    });
});
