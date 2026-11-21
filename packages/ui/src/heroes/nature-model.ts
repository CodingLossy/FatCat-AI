// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 自然主视觉的数值部分(纯函数,无 DOM):一棵由光点和细光线组成的树(枝干、树冠、根)、低处的萤火、
// 各状态的亮度与摆动。坐标在树空间:x 向右、y 向下,树根在 (0, 0.86),树冠顶大约在 y = -0.9。

import type { OrbState } from '../orb-model.js';

export const NATURE_DEPTH = 6;
export const NATURE_CANOPY_COUNT = 1600;
export const NATURE_FIREFLIES = 26;
export const TREE_BASE = { x: 0, y: 0.86 } as const;

export interface Branch {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
    /** 0 是主干,越往外越大。 */
    readonly depth: number;
    /** 父枝的下标;主干为 -1。 */
    readonly parent: number;
    /** 从树根沿枝干走到这根枝起点 / 终点的路程,按最远的枝头归一到 0–1(给「光往上爬」用)。 */
    readonly h0: number;
    readonly h1: number;
}

export interface TreeDot {
    readonly x: number;
    readonly y: number;
    /** 沿枝干的归一化路程(树冠点取所在枝头的值)。 */
    readonly h: number;
    readonly size: number;
    readonly phase: number;
    /** 所在的枝(树冠点是它挂着的枝头)。 */
    readonly branch: number;
}

export interface Tree {
    readonly branches: readonly Branch[];
    /** 枝干上的金色光点。 */
    readonly trunkDots: readonly TreeDot[];
    /** 树冠的浅绿光点。 */
    readonly canopyDots: readonly TreeDot[];
    /** 枝头(最外层的枝)下标,按从左到右的角度排好。 */
    readonly tips: readonly number[];
    /** 根部几根短须。 */
    readonly roots: readonly { x0: number; y0: number; x1: number; y1: number }[];
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

/** 生成整棵树。固定种子可复现;主干向上,每层分两到三杈,越往外越短越细。 */
export function natureTree(seed = 7, depth = NATURE_DEPTH, canopy = NATURE_CANOPY_COUNT): Tree {
    const rand = rng(seed);
    const raw: { x0: number; y0: number; x1: number; y1: number; depth: number; parent: number; len: number }[] = [];
    const grow = (x: number, y: number, angle: number, len: number, d: number, parent: number) => {
        const x1 = x + Math.cos(angle) * len;
        const y1 = y + Math.sin(angle) * len;
        const index = raw.length;
        raw.push({ x0: x, y0: y, x1, y1, depth: d, parent, len });
        if (d >= depth) return;
        const forks = d === 0 ? 3 : rand() < 0.3 ? 3 : 2;
        for (let k = 0; k < forks; k++) {
            const spread = forks === 3 ? (k - 1) * 0.62 : (k === 0 ? -1 : 1) * 0.42;
            // 往上长、略向外张开,外层枝稍微下垂
            const a = angle + spread + (rand() - 0.5) * 0.35 + (d > 3 ? (Math.cos(angle) > 0 ? 0.08 : -0.08) : 0);
            grow(x1, y1, a, len * (0.64 + rand() * 0.1), d + 1, index);
        }
    };
    grow(TREE_BASE.x, TREE_BASE.y, -Math.PI / 2, 0.5, 0, -1);

    // 沿枝干的路程
    const dist: number[] = [];
    raw.forEach((b, i) => {
        const start = b.parent < 0 ? 0 : (dist[b.parent] ?? 0);
        dist[i] = start + b.len;
    });
    const maxDist = Math.max(...dist);
    const branches: Branch[] = raw.map((b, i) => ({
        x0: b.x0,
        y0: b.y0,
        x1: b.x1,
        y1: b.y1,
        depth: b.depth,
        parent: b.parent,
        h0: ((dist[i] ?? 0) - b.len) / maxDist,
        h1: (dist[i] ?? 0) / maxDist,
    }));

    const trunkDots: TreeDot[] = [];
    branches.forEach((b, i) => {
        const len = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
        const count = Math.max(2, Math.round(len * (90 - b.depth * 8)));
        const width = 0.028 * 0.72 ** b.depth;
        for (let k = 0; k < count; k++) {
            const u = rand();
            const off = (rand() - 0.5) * width;
            const nx = -(b.y1 - b.y0) / (len || 1);
            const ny = (b.x1 - b.x0) / (len || 1);
            trunkDots.push({
                x: b.x0 + (b.x1 - b.x0) * u + nx * off,
                y: b.y0 + (b.y1 - b.y0) * u + ny * off,
                h: b.h0 + (b.h1 - b.h0) * u,
                size: rand() ** 2,
                phase: rand() * Math.PI * 2,
                branch: i,
            });
        }
    });

    const tipList = branches.map((b, i) => ({ b, i })).filter(({ b }) => b.depth === depth);
    const canopyDots: TreeDot[] = [];
    for (let k = 0; k < canopy; k++) {
        const pick = tipList[Math.floor(rand() * tipList.length)];
        if (!pick) break;
        const r = 0.13 * Math.sqrt(rand());
        const a = rand() * Math.PI * 2;
        canopyDots.push({
            x: pick.b.x1 + Math.cos(a) * r,
            y: pick.b.y1 + Math.sin(a) * r * 0.8,
            h: pick.b.h1,
            size: rand() ** 2,
            phase: rand() * Math.PI * 2,
            branch: pick.i,
        });
    }

    // 打乱顺序:低画质时只画前一部分,打乱后各处一样稀,不会只剩半棵树
    const shuffle = <T>(list: T[]) => {
        for (let k = list.length - 1; k > 0; k--) {
            const j = Math.floor(rand() * (k + 1));
            [list[k], list[j]] = [list[j] as T, list[k] as T];
        }
        return list;
    };
    shuffle(trunkDots);

    const tips = tipList
        .map(({ b, i }) => ({ i, a: Math.atan2(b.y1 - TREE_BASE.y, b.x1 - TREE_BASE.x) }))
        .sort((p, q) => p.a - q.a)
        .map((p) => p.i);

    const roots: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (let k = 0; k < 7; k++) {
        const a = Math.PI / 2 + (k / 6 - 0.5) * 2.4 + (rand() - 0.5) * 0.2;
        const len = 0.06 + rand() * 0.08;
        roots.push({
            x0: TREE_BASE.x,
            y0: TREE_BASE.y,
            x1: TREE_BASE.x + Math.cos(a) * len * 1.6,
            y1: TREE_BASE.y + Math.sin(a) * len * 0.5,
        });
    }
    return { branches, trunkDots, canopyDots, tips, roots };
}

/** 从主干到第 i 根枝的整条枝链(含它自己),从下往上。 */
export function branchChain(tree: Tree, i: number): number[] {
    const out: number[] = [];
    for (let k = i; k >= 0; k = tree.branches[k]?.parent ?? -1) out.unshift(k);
    return out;
}

/** 把 n 个第一层节点均匀分到枝头上(枝头数不够时按顺序重复使用)。 */
export function tipsFor(tree: Tree, n: number): number[] {
    const t = tree.tips.length;
    if (!t || n <= 0) return [];
    if (n >= t) return Array.from({ length: n }, (_, k) => tree.tips[k % t] as number);
    return Array.from({ length: n }, (_, k) => tree.tips[Math.round(((k + 0.5) / n) * t - 0.5)] as number);
}

export interface Firefly {
    readonly x: number;
    readonly y: number;
    readonly phase: number;
    readonly speed: number;
}

/** 低处的萤火:在树根附近和地面上方缓慢绕圈。 */
export function natureFireflies(n = NATURE_FIREFLIES, seed = 3): Firefly[] {
    const rand = rng(seed);
    return Array.from({ length: n }, () => ({
        x: (rand() - 0.5) * 1.9,
        y: 0.35 + rand() * 0.6,
        phase: rand() * Math.PI * 2,
        speed: 0.4 + rand() * 0.6,
    }));
}

export interface NatureLook {
    /** 枝干 / 树冠的整体亮度(0–1)。 */
    readonly brightness: number;
    /** 树冠点的闪烁幅度。 */
    readonly shimmer: number;
    /** 摆动幅度(树空间单位,树顶处的最大水平位移)。 */
    readonly sway: number;
    /** 光沿树干往上爬的速度(每秒走过的归一化路程);0 表示不爬。 */
    readonly climb: number;
    /** 萤火聚向树的程度(0–1)。 */
    readonly gather: number;
}

/** 待机最暗且轻摆;聆听树冠更亮、萤火聚拢;思考时光沿树干往上爬;说话时整树随音量摇;知识模式压暗。 */
export function natureLook(state: OrbState, level: number, knowledge: boolean): NatureLook {
    const lv = Math.min(1, Math.max(0, level));
    const base: NatureLook =
        state === 'listening'
            ? { brightness: 0.95, shimmer: 0.35, sway: 0.008, climb: 0, gather: 0.6 }
            : state === 'thinking' || state === 'executing'
              ? { brightness: 0.9, shimmer: 0.15, sway: 0.006, climb: 0.45, gather: 0.2 }
              : state === 'speaking'
                ? { brightness: 1, shimmer: 0.25 + 0.3 * lv, sway: 0.012 + 0.06 * lv, climb: 0, gather: 0.3 }
                : { brightness: 0.78, shimmer: 0.12, sway: 0.006, climb: 0, gather: 0 };
    return knowledge ? { ...base, brightness: base.brightness * 0.55, sway: 0.004, climb: 0, gather: 0 } : base;
}

/** 摆动:离树根越高位移越大(树根不动)。 */
export function swayOffset(y: number, sway: number, tSec: number): number {
    const lift = Math.max(0, TREE_BASE.y - y) / (TREE_BASE.y + 0.95);
    return sway * lift ** 1.6 * Math.sin(tSec * 1.9 + y * 1.3);
}

/** 爬升光带在路程 h 处的亮度加成(0–1):一道向上走的光,走到顶后从根部重来。 */
export function climbGlow(h: number, climb: number, tSec: number): number {
    if (climb <= 0) return 0;
    const front = (tSec * climb) % 1.25;
    const d = front - h;
    return d < 0 || d > 0.18 ? 0 : 1 - d / 0.18;
}
