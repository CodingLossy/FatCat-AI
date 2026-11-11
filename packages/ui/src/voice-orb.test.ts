// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { createVoiceOrb, fibonacciSphere, ORB_COLORS, orbScale, spinRate } from './voice-orb.js';

describe('VoiceOrb', () => {
    it('五种状态的颜色互不相同', () => {
        expect(new Set(Object.values(ORB_COLORS)).size).toBe(5);
    });

    it('粒子都在单位球面上', () => {
        const points = fibonacciSphere(50);
        expect(points).toHaveLength(50);
        for (const [x, y, z] of points) expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    });

    it('有电平时随电平脉动,没有电平时呼吸,减少动态时恒定', () => {
        expect(orbScale(0, 0, 'listening', false)).toBe(1);
        expect(orbScale(0, 1, 'listening', false)).toBeCloseTo(1.3);
        expect(orbScale(0, 5, 'speaking', false)).toBeCloseTo(1.3);
        expect(orbScale(500, null, 'speaking', false)).toBeGreaterThan(1);
        expect(orbScale(500, 1, 'speaking', true)).toBe(1);
        expect(spinRate('thinking')).toBeGreaterThan(spinRate('idle'));
    });

    it('Canvas 不可用时返回 null', () => {
        const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
        expect(createVoiceOrb(canvas)).toBeNull();
    });
});
