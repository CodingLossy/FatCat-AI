// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    STARS_PER_CONSTELLATION,
    starLift,
    TECH_CONSTELLATIONS,
    techConstellations,
    techLook,
    techStars,
} from './heroes/tech-model.js';
import { DEFAULT_THEME, resolveTheme } from './theme-ids.js';

describe('resolveTheme', () => {
    it('旧值、未知值和还没做好的主题一律按科技处理;科技本身保持', () => {
        for (const old of ['system', 'light', 'dark', 'obsidian', 'nebula', 'nature', 'cat', '', null, undefined, 3]) {
            expect(resolveTheme(old)).toBe(DEFAULT_THEME);
        }
        expect(resolveTheme('tech')).toBe('tech');
        expect(DEFAULT_THEME).toBe('tech');
    });
});

describe('tech hero model', () => {
    it('星点和星座固定种子可复现,星座点都在单位球面上', () => {
        expect(techStars(50)).toEqual(techStars(50));
        const stars = techStars(2000);
        const share = (c: number) => stars.filter((s) => s.color === c).length / stars.length;
        expect(share(0)).toBeGreaterThan(0.65);
        expect(share(1)).toBeGreaterThan(0.08);
        expect(share(2)).toBeGreaterThan(0.08);
        const groups = techConstellations();
        expect(groups).toHaveLength(TECH_CONSTELLATIONS);
        for (const g of groups) {
            expect(g.points).toHaveLength(STARS_PER_CONSTELLATION);
            for (const [x, y, z] of g.points) expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
        }
    });

    it('聆听偏青、思考偏紫且转得更快,说话时星点随音量起伏,知识模式整体压暗', () => {
        expect(techLook('listening', false).tintColor).toBe(2);
        expect(techLook('thinking', false).tintColor).toBe(1);
        expect(techLook('thinking', false).spin).toBeGreaterThan(techLook('listening', false).spin);
        expect(techLook('idle', false).tintAmount).toBe(0);
        expect(techLook('idle', true).brightness).toBeLessThan(techLook('idle', false).brightness);
        expect(starLift('speaking', 0, 1, 1)).toBe(0);
        expect(Math.abs(starLift('speaking', 1, 0.5, 0.3))).toBeGreaterThan(0);
        expect(starLift('listening', 1, 0.5, 0.3)).toBe(0);
    });
});
