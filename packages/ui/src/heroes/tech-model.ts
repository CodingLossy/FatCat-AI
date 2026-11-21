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
    /** 被染色的星点比例(0–1)和染成的颜色(1 淡紫 / 2 青)。 */
    readonly tintAmount: number;
    readonly tintColor: 1 | 2;
    /** 自转速度(弧度 / 秒)。 */
    readonly spin: number;
    /** 星点总体亮度(0–1)。 */
    readonly brightness: number;
    /** 星座连线亮度(0–1)。 */
    readonly lines: number;
}

/** 聆听偏青、思考偏紫并缓慢旋转、说话保持白色(星点随音量起伏由绘制处处理)、待机最暗;知识模式整体压暗且不画装饰连线。 */
export function techLook(state: OrbState, knowledge: boolean): TechLook {
    const base: TechLook =
        state === 'listening'
            ? { tintAmount: 0.45, tintColor: 2, spin: 0.07, brightness: 0.9, lines: 0.5 }
            : state === 'thinking' || state === 'executing'
              ? { tintAmount: 0.5, tintColor: 1, spin: 0.16, brightness: 0.95, lines: 0.6 }
              : state === 'speaking'
                ? { tintAmount: 0.12, tintColor: 2, spin: 0.06, brightness: 1, lines: 0.55 }
                : { tintAmount: 0, tintColor: 2, spin: 0.04, brightness: 0.75, lines: 0.4 };
    // 知识模式:星球压暗、装饰用的星座连线隐去,只留知识节点自己的连线
    return knowledge ? { ...base, spin: base.spin * 0.5, brightness: base.brightness * 0.6, lines: 0 } : base;
}

/** 说话时单颗星点向外的位移比例,随电平和各自的相位起伏;其他状态为 0。 */
export function starLift(state: OrbState, level: number, phase: number, tSec: number): number {
    if (state !== 'speaking') return 0;
    return 0.07 * Math.min(1, Math.max(0, level)) * Math.sin(phase * 3 + tSec * 6);
}
