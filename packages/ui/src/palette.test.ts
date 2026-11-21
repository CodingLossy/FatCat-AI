// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { MEMORY_COLORS } from './map-viz/logic.js';
import { cssToken, resolveColor } from './palette.js';

describe('palette', () => {
    it('没有 DOM 时 token 用 fallback,普通颜色原样返回', () => {
        expect(cssToken(null, '--accent', 'white')).toBe('white');
        expect(resolveColor(null, '--accent', 'white')).toBe('white');
        expect(resolveColor(null, 'red')).toBe('red');
    });

    it('地图颜色是 token 名而不是写死的色值', () => {
        for (const value of Object.values(MEMORY_COLORS)) expect(value.startsWith('--map-')).toBe(true);
    });
});
