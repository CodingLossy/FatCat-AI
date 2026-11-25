// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    motionState,
    parseColor,
    readStateColors,
    type StateColors,
    stepTint,
    tintTarget,
} from './heroes/state-tint.js';

const COLORS: StateColors = {
    listening: [214, 236, 255],
    heard: [61, 245, 138],
    thinking: [168, 117, 255],
    speaking: [46, 125, 255],
};

describe('主视觉的状态色(ADR 0049 第 10.4 节)', () => {
    it('每个状态一种颜色;待机不染色;执行工具与思考同色;检测到语音按聆听的运动', () => {
        expect(tintTarget('idle').amount).toBe(0);
        expect(tintTarget('listening').key).toBe('listening');
        expect(tintTarget('heard').key).toBe('heard');
        expect(tintTarget('thinking').key).toBe('thinking');
        expect(tintTarget('executing').key).toBe('thinking');
        expect(tintTarget('speaking').key).toBe('speaking');
        expect(motionState('heard')).toBe('listening');
        expect(motionState('speaking')).toBe('speaking');
    });

    it('平滑过渡:每帧靠近一步,不跳;减少动态时直接到目标色', () => {
        const start = stepTint({ color: COLORS.listening, amount: 0 }, 'listening', COLORS, 0, true);
        expect(start).toEqual({ color: COLORS.listening, amount: 0.55 });
        // 聆听 → 思考:一帧(16 ms)之后在两者之间
        const one = stepTint(start, 'thinking', COLORS, 16, false);
        expect(one.color[0]).toBeLessThan(COLORS.listening[0]);
        expect(one.color[0]).toBeGreaterThan(COLORS.thinking[0]);
        // 一秒后基本到位
        let t = start;
        for (let i = 0; i < 60; i++) t = stepTint(t, 'thinking', COLORS, 16, false);
        expect(Math.abs(t.color[1] - COLORS.thinking[1])).toBeLessThan(1);
        expect(Math.abs(t.amount - 0.65)).toBeLessThan(0.01);
        // 减少动态:一步到位
        expect(stepTint(start, 'speaking', COLORS, 16, true).color).toEqual(COLORS.speaking);
        // 从待机进入:颜色直接取目标色,只有比例慢慢升
        const fromIdle = stepTint({ color: COLORS.thinking, amount: 0 }, 'heard', COLORS, 16, false);
        expect(fromIdle.color).toEqual(COLORS.heard);
        expect(fromIdle.amount).toBeGreaterThan(0);
        expect(fromIdle.amount).toBeLessThan(0.75);
    });

    it('颜色解析:#rgb、#rrggbb、rgb();认不出的写法用后备色', () => {
        expect(parseColor('#fff')).toEqual([255, 255, 255]);
        expect(parseColor(' #2e7dff ')).toEqual([46, 125, 255]);
        expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3]);
        expect(parseColor('hsl(0 0% 0%)')).toBeNull();
        const vars: Record<string, string> = { '--hero-state-heard': '#000000', '--hero-state-speaking': 'oops' };
        const read = readStateColors((n) => vars[n] ?? '', 'hero', COLORS);
        expect(read.heard).toEqual([0, 0, 0]);
        expect(read.speaking).toEqual(COLORS.speaking);
        expect(read.listening).toEqual(COLORS.listening);
    });

    it('三套主题在 tokens.css 里都有四种状态色', () => {
        const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8');
        for (const prefix of ['hero', 'nature', 'cat']) {
            for (const key of ['listening', 'heard', 'thinking', 'speaking']) {
                const m = new RegExp(`--${prefix}-state-${key}:\\s*(#[0-9a-f]{6});`, 'i').exec(css);
                expect(m, `${prefix} ${key}`).not.toBeNull();
                expect(parseColor(m![1]!)).not.toBeNull();
            }
        }
    });
});
