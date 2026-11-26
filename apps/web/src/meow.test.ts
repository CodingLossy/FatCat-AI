// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { MEOW_GAP_MS, MEOW_MIN_LEVEL, MEOW_PEAK_GAIN, meowDue, playMeow } from './meow.js';

describe('meow', () => {
    const now = 10_000;

    it('默认不叫:没开、没在说话、音量不够、或离上一声太近', () => {
        expect(meowDue(1, now, 1, false, true)).toBe(false);
        expect(meowDue(1, now, 1, true, false)).toBe(false);
        expect(meowDue(1, now, MEOW_MIN_LEVEL - 0.01, true, true)).toBe(false);
        expect(meowDue(0, now, 1, true, true)).toBe(false);
        expect(meowDue(now - MEOW_GAP_MS + 50, now, 1, true, true)).toBe(false);
    });

    it('开着、正在朗读、音量够、并且隔了几秒,才叫一声', () => {
        expect(meowDue(now - MEOW_GAP_MS, now, MEOW_MIN_LEVEL, true, true)).toBe(true);
    });

    it('合成的一声峰值很低,不盖住朗读', () => {
        const gains: number[] = [];
        const ctx = {
            currentTime: 0,
            destination: {},
            createOscillator: () => ({
                type: 'sine',
                frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
                connect() {},
                start() {},
                stop() {},
            }),
            createGain: () => ({
                gain: {
                    setValueAtTime() {},
                    exponentialRampToValueAtTime(value: number) {
                        gains.push(value);
                    },
                },
                connect() {},
            }),
        };
        playMeow(ctx as unknown as AudioContext);
        expect(Math.max(...gains)).toBeLessThanOrEqual(MEOW_PEAK_GAIN);
        expect(MEOW_PEAK_GAIN).toBeLessThan(0.1);
    });
});
