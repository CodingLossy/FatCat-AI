// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    compactDisplay,
    createVoiceOrb,
    fibonacciSphere,
    generateParticles,
    initialQuality,
    MAX_PARTICLES,
    MIN_QUALITY,
    orbEnergy,
    particleCount,
    presetFor,
    projectPoint,
    stepQuality,
    waveHeights,
} from './voice-orb.js';

describe('core orb model', () => {
    it('三种状态的密度与转速符合设计,executing / idle 沿用已有外观', () => {
        expect(presetFor('listening').density).toBe(0.5);
        expect(presetFor('thinking').density).toBe(1);
        expect(presetFor('speaking').density).toBe(0.78);
        expect(presetFor('thinking').spin).toBeGreaterThan(presetFor('speaking').spin);
        expect(presetFor('speaking').spin).toBeGreaterThan(presetFor('listening').spin);
        expect(presetFor('executing')).toBe(presetFor('thinking'));
        expect(presetFor('idle')).toBe(presetFor('listening'));
        expect(particleCount(presetFor('thinking'), 1)).toBe(MAX_PARTICLES);
        expect(particleCount(presetFor('listening'), 1)).toBe(1300);
    });

    it('自适应质量:连续慢帧按 20% 下调、有下限、不回升;低端设备从 60% 起步', () => {
        let s = { quality: 1, slow: 0 };
        for (let i = 0; i < 46; i++) s = stepQuality(s, 40);
        expect(s.quality).toBeCloseTo(0.8);
        for (let i = 0; i < 2000; i++) s = stepQuality(s, 40);
        expect(s.quality).toBe(MIN_QUALITY);
        for (let i = 0; i < 500; i++) s = stepQuality(s, 8);
        expect(s.quality).toBe(MIN_QUALITY);
        expect(stepQuality({ quality: 1, slow: 10 }, 5000)).toEqual({ quality: 1, slow: 10 }); // 标签页恢复不算慢帧
        expect(initialQuality(4, undefined)).toBe(0.6);
        expect(initialQuality(undefined, 2)).toBe(0.6);
        expect(initialQuality(8, 8)).toBe(1);
        // 手机屏幕(短边 < 600px)从降低的粒子数起步;读不到屏幕尺寸时不算
        expect(initialQuality(8, 8, 390)).toBe(0.6);
        expect(initialQuality(8, 8, 1080)).toBe(1);
        expect(initialQuality(8, 8, 0)).toBe(1);
        expect(compactDisplay(800, 390)).toBe(true);
        expect(compactDisplay(800, 1080)).toBe(false);
        expect(compactDisplay(200, 1080)).toBe(true);
        expect(compactDisplay(800, 0)).toBe(false);
    });

    it('粒子生成是确定的、在单位球面上,投影近大远小', () => {
        const a = generateParticles(100);
        expect(generateParticles(100)).toEqual(a);
        for (const p of a) expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 6);
        // 降低密度只取前缀:前 50% 仍然覆盖上下两个半球
        const half = generateParticles(MAX_PARTICLES).slice(0, MAX_PARTICLES / 2);
        expect(half.filter((p) => p.y > 0.5).length).toBeGreaterThan(100);
        expect(half.filter((p) => p.y < -0.5).length).toBeGreaterThan(100);
        const proj = { cx: 0, cy: 0, radius: 100, rotation: 0, tilt: 0 };
        const near = projectPoint(0, 0, 1, proj); // rotation 0:z 保持不变
        const far = projectPoint(0, 0, -1, proj);
        expect(near[2]).toBeCloseTo(1);
        expect(far[2]).toBeCloseTo(-1);
        // 同样的横向偏移,近处的点投影得更远离中心
        const nearSide = projectPoint(0.5, 0, 0.8, proj);
        const farSide = projectPoint(0.5, 0, -0.8, proj);
        expect(nearSide[0]).toBeGreaterThan(farSide[0]);
        expect(fibonacciSphere(1)).toHaveLength(1);
    });

    it('电平与声波条:有电平用电平,说话时声波条高于其他状态,最低高度为 3px', () => {
        expect(orbEnergy('listening', 2, 0)).toBe(1);
        expect(orbEnergy('listening', null, 1)).toBe(0);
        expect(orbEnergy('speaking', null, 1)).toBeGreaterThan(0);
        const peak = (state: 'speaking' | 'listening') => Math.max(...waveHeights(56, state, 1, 0.37, 48));
        expect(peak('speaking')).toBeGreaterThan(peak('listening'));
        expect(Math.min(...waveHeights(56, 'speaking', 0, 0, 48))).toBeGreaterThanOrEqual(3);
        expect(new Set(waveHeights(56, 'speaking', 1, 0.37, 48, true))).toEqual(new Set([3])); // 减少动效:全部最低
    });

    it('Canvas 不可用时返回 null', () => {
        const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
        expect(createVoiceOrb(canvas)).toBeNull();
    });
});
