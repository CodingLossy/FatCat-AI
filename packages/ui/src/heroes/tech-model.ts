// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 科技主视觉的数值部分(纯函数,无 DOM):几千颗星点的球、边缘的星座连线、各状态的色调与转速。

import type { OrbState, Point3 } from '../orb-model.js';

export const TECH_STAR_COUNT = 3200;
export const TECH_CONSTELLATIONS = 6;
export const STARS_PER_CONSTELLATION = 5;

export interface TechStar {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    /** 0 白、1 淡紫、2 青:星点自己的颜色。 */
    readonly color: 0 | 1 | 2;
    /** 0–1 的随机序,状态换色时按它决定哪些星点被染上。 */
    readonly rank: number;
    readonly size: number;
    readonly phase: number;
}

export interface Constellation {
    /** 星座里的星点(球面上,靠近一个方向),按连线顺序排列。 */
    readonly points: readonly Point3[];
}

function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function unitVector(rand: () => number): Point3 {
    const z = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), z, r * Math.sin(a)];
}

/** 白 72%、淡紫 14%、青 14%;半径偏向外壳(球看起来是一层星壳加内部稀疏的星)。 */
export function techStars(n: number, seed = 11): TechStar[] {
    const rand = rng(seed);
    const stars: TechStar[] = [];
    for (let i = 0; i < n; i++) {
        const [x, y, z] = unitVector(rand);
        const r = rand() < 0.7 ? 0.9 + rand() * 0.1 : Math.cbrt(rand()) * 0.9;
        const c = rand();
        stars.push({
            x: x * r,
            y: y * r,
            z: z * r,
            color: c < 0.72 ? 0 : c < 0.86 ? 1 : 2,
            rank: rand(),
            size: rand() ** 2,
            phase: rand() * Math.PI * 2,
        });
    }
    return stars;
}

/** 边缘几簇星座:每簇在球面上取一个方向,附近放几个点,依次连线。 */
export function techConstellations(count = TECH_CONSTELLATIONS, seed = 5): Constellation[] {
    const rand = rng(seed);
    const out: Constellation[] = [];
    for (let i = 0; i < count; i++) {
        const [cx, cy, cz] = unitVector(rand);
        const points: Point3[] = [];
        for (let j = 0; j < STARS_PER_CONSTELLATION; j++) {
            const x = cx + (rand() - 0.5) * 0.45;
            const y = cy + (rand() - 0.5) * 0.45;
            const z = cz + (rand() - 0.5) * 0.45;
            const len = Math.hypot(x, y, z) || 1;
            points.push([x / len, y / len, z / len]);
        }
        out.push({ points });
    }
    return out;
}

export interface TechLook {
    /** 自转速度(弧度 / 秒);负数是反方向。 */
    readonly spin: number;
    /** 球轴前后摆动的幅度(弧度):思考时换一种转法(反向自转加上摆动)。 */
    readonly wobble: number;
    /** 星点总体亮度(0–1)。 */
    readonly brightness: number;
    /** 星座连线亮度(0–1)。 */
    readonly lines: number;
}

/**
 * 各状态的运动与亮度(颜色在 state-tint.ts):聆听慢转;思考反向自转并且球轴前后摆动;说话慢转,星点随音量
 * 向外脉动(绘制处);待机最暗。知识模式整体压暗且不画装饰连线。
 */
export function techLook(state: OrbState, knowledge: boolean): TechLook {
    const base: TechLook =
        state === 'listening'
            ? { spin: 0.07, wobble: 0, brightness: 0.9, lines: 0.5 }
            : state === 'thinking' || state === 'executing'
              ? { spin: -0.22, wobble: 0.22, brightness: 0.95, lines: 0.6 }
              : state === 'speaking'
                ? { spin: 0.06, wobble: 0, brightness: 1, lines: 0.55 }
                : { spin: 0.04, wobble: 0, brightness: 0.75, lines: 0.4 };
    // 知识模式:星球压暗、装饰用的星座连线隐去,只留知识节点自己的连线
    return knowledge
        ? { ...base, spin: Math.abs(base.spin) * 0.5, wobble: 0, brightness: base.brightness * 0.6, lines: 0 }
        : base;
}

/** 说话时单颗星点向外的位移比例(只向外,不向里缩),随朗读音量和各自的相位脉动;其他状态为 0。 */
export function starLift(state: OrbState, level: number, phase: number, tSec: number): number {
    if (state !== 'speaking') return 0;
    return 0.1 * Math.min(1, Math.max(0, level)) * (0.55 + 0.45 * Math.sin(phase * 3 + tSec * 6));
}

/** 说话亮度的时间常数(毫秒):跟音量起伏,但不跟着每一帧硬跳。 */
export const SPEAK_GLOW_MS = 260;
/** 平滑音量为 1 时,在状态亮度之外再亮这么多(倍数里的增量)。 */
export const SPEAK_GLOW_GAIN = 0.62;

function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
}

/**
 * 说话时的亮度驱动(0–1)。指数缓动靠近当前音量;说话结束(或没有电平)时缓回 0。
 * 减少动态时保持 0:只留状态色,不做呼吸灯。单步不会跳到目标,避免闪烁。
 */
export function stepSpeakGlow(
    prev: number,
    level: number | null,
    speaking: boolean,
    dtMs: number,
    reduced: boolean,
): number {
    if (reduced) return 0;
    const target = speaking ? clamp01(level ?? 0) : 0;
    if (!(dtMs > 0)) return prev;
    const k = 1 - Math.exp(-Math.min(dtMs, 100) / SPEAK_GLOW_MS);
    const next = prev + (target - prev) * k;
    return target === 0 && next < 0.001 ? 0 : next;
}

/** 把亮度驱动乘到状态亮度上。驱动为 0 时就是原来的亮度。 */
export function speakBrightness(base: number, glow: number): number {
    return base * (1 + SPEAK_GLOW_GAIN * clamp01(glow));
}
