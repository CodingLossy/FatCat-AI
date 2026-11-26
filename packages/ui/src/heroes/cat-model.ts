// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 猫咪主视觉的数值部分(纯函数,无 DOM):一只单线条线稿的坐猫(头、两只耳朵、身子、前腿、尾巴、脸),
// 线上缀着的小光点,以及各状态的耳朵、尾巴、呼吸和沿轮廓流动的光。坐标:x 向右、y 向下,猫大致在 [-1, 1] 里。

import type { OrbState } from '../orb-model.js';

export type CatPart = 'head' | 'earL' | 'earR' | 'body' | 'legs' | 'tail' | 'face';
export type Pt = readonly [number, number];

export interface CatStroke {
    readonly part: CatPart;
    readonly points: readonly Pt[];
}

/** 耳朵转动的支点(耳根中点)和尾巴的支点(尾根)。 */
export const EAR_L_PIVOT: Pt = [-0.2, -0.66];
export const EAR_R_PIVOT: Pt = [0.2, -0.66];
export const TAIL_PIVOT: Pt = [0.42, 0.78];

const HEAD = { cx: 0, cy: -0.42, rx: 0.33, ry: 0.28 };
const STEP = 0.012;

function headAt(deg: number): Pt {
    const a = (deg * Math.PI) / 180;
    return [HEAD.cx + HEAD.rx * Math.cos(a), HEAD.cy + HEAD.ry * Math.sin(a)];
}

/** 一段圆弧(角度单位为度,y 向下时 90° 在最下面),按步长取点。 */
function arc(from: number, to: number): Pt[] {
    const n = Math.max(2, Math.ceil(((Math.abs(to - from) / 180) * Math.PI * HEAD.rx) / STEP));
    return Array.from({ length: n + 1 }, (_, k) => headAt(from + ((to - from) * k) / n));
}

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt[] {
    const len =
        Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
        Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
        Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
    const n = Math.max(2, Math.ceil(len / STEP));
    return Array.from({ length: n + 1 }, (_, k) => {
        const t = k / n;
        const u = 1 - t;
        return [
            u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
        ] as Pt;
    });
}

function line(a: Pt, b: Pt): Pt[] {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / STEP));
    return Array.from(
        { length: n + 1 },
        (_, k) => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n] as Pt,
    );
}

/** 整只猫的线条。顺序固定:头(含耳朵)、身子、前腿、尾巴、脸。 */
export function catStrokes(): CatStroke[] {
    const earL = [...line(headAt(200), [-0.34, -0.9]), ...line([-0.34, -0.9], headAt(247)).slice(1)];
    const earR = [...line(headAt(293), [0.34, -0.9]), ...line([0.34, -0.9], headAt(340)).slice(1)];
    return [
        { part: 'head', points: arc(200, -20) },
        { part: 'earR', points: earR },
        { part: 'head', points: arc(293, 247) },
        { part: 'earL', points: earL },
        {
            part: 'body',
            points: [
                ...cubic([-0.2, -0.17], [-0.5, 0.0], [-0.62, 0.55], [-0.42, 0.8]),
                ...line([-0.42, 0.8], [0.42, 0.8]).slice(1),
                ...cubic([0.42, 0.8], [0.62, 0.55], [0.5, 0.0], [0.2, -0.17]).slice(1),
            ],
        },
        { part: 'legs', points: [...line([-0.13, 0.12], [-0.13, 0.8])] },
        { part: 'legs', points: [...line([0.13, 0.12], [0.13, 0.8])] },
        { part: 'tail', points: cubic(TAIL_PIVOT, [0.95, 0.82], [0.98, 0.25], [0.72, 0.12]) },
        // 脸:两只眯起的眼睛、鼻子和嘴
        { part: 'face', points: cubic([-0.17, -0.44], [-0.14, -0.4], [-0.08, -0.4], [-0.05, -0.44]) },
        { part: 'face', points: cubic([0.05, -0.44], [0.08, -0.4], [0.14, -0.4], [0.17, -0.44]) },
        {
            part: 'face',
            points: [...line([-0.025, -0.34], [0.025, -0.34]), ...line([0.025, -0.34], [0, -0.31]).slice(1)],
        },
        { part: 'face', points: cubic([0, -0.31], [0, -0.27], [-0.05, -0.27], [-0.06, -0.29]) },
        { part: 'face', points: cubic([0, -0.31], [0, -0.27], [0.05, -0.27], [0.06, -0.29]) },
    ];
}

/** 胡须:每边三根,从脸颊往外。只画线,不挂光点。 */
export function catWhiskers(): [Pt, Pt][] {
    const out: [Pt, Pt][] = [];
    for (const side of [-1, 1]) {
        for (const k of [-1, 0, 1]) {
            out.push([
                [side * 0.12, -0.32 + k * 0.025],
                [side * 0.48, -0.36 + k * 0.07],
            ]);
        }
    }
    return out;
}

export interface CatPose {
    /** 耳朵相对静止位置的转角(弧度,正值向外)。 */
    readonly earL: number;
    readonly earR: number;
    /** 尾巴绕尾根的转角(弧度,正值向上卷)。 */
    readonly tail: number;
    /** 呼吸:整只猫纵向缩放的增量。 */
    readonly breathe: number;
    /** 沿轮廓流动的光:亮度(0–1)和每秒走过的轮廓比例。 */
    readonly flow: number;
    readonly flowSpeed: number;
    /** 光点整体亮度(0–1)。 */
    readonly brightness: number;
    /** 嘴张开的程度(0 合上,1 全开)。只有说话时跟着音量。 */
    readonly mouth: number;
}

/** 聆听时耳朵动、思考时尾巴摆、说话时光顺着轮廓流动(随音量变亮变快),嘴也随音量开合;知识模式静下来并压暗。 */
export function catPose(state: OrbState, level: number, tSec: number, knowledge: boolean): CatPose {
    const lv = Math.min(1, Math.max(0, level));
    const breathe = 0.012 * Math.sin(tSec * 1.4);
    if (knowledge)
        return {
            earL: 0,
            earR: 0,
            tail: 0.05 * Math.sin(tSec * 0.8),
            breathe,
            flow: 0,
            flowSpeed: 0,
            brightness: 0.55,
            mouth: 0,
        };
    if (state === 'listening') {
        // 两只耳朵轮流抖一下
        const twitch = (phase: number) => {
            const x = (tSec * 1.6 + phase) % 2;
            return x < 0.35 ? 0.22 * Math.sin((x / 0.35) * Math.PI) : 0;
        };
        return {
            earL: twitch(0),
            earR: twitch(1),
            tail: 0.06 * Math.sin(tSec),
            breathe,
            flow: 0,
            flowSpeed: 0,
            brightness: 0.95,
            mouth: 0,
        };
    }
    if (state === 'thinking' || state === 'executing') {
        return {
            earL: 0,
            earR: 0,
            tail: 0.32 * Math.sin(tSec * 2.4),
            breathe,
            flow: 0,
            flowSpeed: 0,
            brightness: 0.9,
            mouth: 0,
        };
    }
    if (state === 'speaking') {
        // 耳朵和尾巴只动一点,幅度跟着音量;嘴张开的程度就是音量
        const ear = 0.07 * (0.35 + 0.65 * lv);
        return {
            earL: ear * Math.sin(tSec * 2.6),
            earR: ear * Math.sin(tSec * 2.6 + 0.9),
            tail: (0.05 + 0.1 * lv) * Math.sin(tSec * 1.7),
            breathe: breathe + 0.012 * lv,
            flow: 0.45 + 0.55 * lv,
            flowSpeed: 0.18 + 0.3 * lv,
            brightness: 1,
            mouth: lv,
        };
    }
    return {
        earL: 0,
        earR: 0,
        tail: 0.08 * Math.sin(tSec * 0.9),
        breathe,
        flow: 0,
        flowSpeed: 0,
        brightness: 0.8,
        mouth: 0,
    };
}

/**
 * 说话时多出来的下唇(猫空间),一笔细线,不闭合、不填色。
 * 音量很低时为空,沿用线稿上原来的小弧。张开时下唇从两个嘴角垂下一条窄缝,
 * 最开也不过一条猫嘴,不是圆洞。
 */
export function catMouth(open: number): Pt[][] {
    const o = Math.min(1, Math.max(0, open));
    if (o < 0.12) return [];
    const drop = 0.008 + 0.028 * o;
    return [cubic([-0.06, -0.29], [-0.028, -0.272 + drop], [0.028, -0.272 + drop], [0.06, -0.29])];
}

/** 说话时偶尔冒出的小字。 */
export const MEOW_TEXT = '喵~';
export const BUBBLE_GAP_S = 4.5;
export const BUBBLE_LIFE_S = 1.6;

export interface MeowBubble {
    age: number;
    life: number;
    x: number;
    y: number;
}

export interface BubbleField {
    bubbles: MeowBubble[];
    /** 离下一次可以出现还要等的秒数。 */
    wait: number;
    side: 1 | -1;
}

export function createBubbles(): BubbleField {
    return { bubbles: [], wait: 1.2, side: 1 };
}

/** 气泡很快淡入,中间保持不透明(字要看得清),最后再淡出。 */
export function bubbleOpacity(age: number, life: number): number {
    if (life <= 0 || age < 0 || age >= life) return 0;
    const u = age / life;
    if (u < 0.12) return u / 0.12;
    if (u > 0.72) return (1 - u) / 0.28;
    return 1;
}

/**
 * 说话而且音量够高时,每隔几秒在头旁边放一个「喵~」,同时最多一个。
 * 减少动态时不放(那是额外的运动)。说话停下后已有的淡完,不马上再放一个。
 */
export function stepBubbles(
    field: BubbleField,
    dtMs: number,
    speaking: boolean,
    level: number,
    reduced: boolean,
): BubbleField {
    if (reduced) return { bubbles: [], wait: field.wait, side: field.side };
    const dt = Math.max(0, dtMs) / 1000;
    const bubbles = field.bubbles.map((b) => ({ ...b, age: b.age + dt })).filter((b) => b.age < b.life);
    const lv = Math.min(1, Math.max(0, level));
    if (!speaking || lv < 0.28) {
        const wait = !speaking && field.wait < 1.2 ? 1.2 : field.wait;
        return { bubbles, wait, side: field.side };
    }
    let wait = field.wait - dt;
    let side = field.side;
    if (wait <= 0 && bubbles.length < 1) {
        bubbles.push({ age: 0, life: BUBBLE_LIFE_S, x: side * 0.62, y: -0.82 });
        side = side === 1 ? -1 : 1;
        wait = BUBBLE_GAP_S;
    }
    return { bubbles, wait, side };
}

function rotate(p: Pt, pivot: Pt, angle: number): Pt {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const dx = p[0] - pivot[0];
    const dy = p[1] - pivot[1];
    return [pivot[0] + dx * c - dy * s, pivot[1] + dx * s + dy * c];
}

/** 按姿势移动一个点:耳朵绕耳根转、尾巴绕尾根转,再整体按呼吸纵向缩放(以地面为基准)。 */
export function posePoint(part: CatPart, p: Pt, pose: CatPose): Pt {
    let q = p;
    if (part === 'earL') q = rotate(q, EAR_L_PIVOT, -pose.earL);
    else if (part === 'earR') q = rotate(q, EAR_R_PIVOT, pose.earR);
    else if (part === 'tail') q = rotate(q, TAIL_PIVOT, -pose.tail);
    return [q[0], 0.8 - (0.8 - q[1]) * (1 + pose.breathe)];
}

/** 脸(眼睛、鼻子、嘴和胡须)所在的圆:知识模式的节点和标签都让开这里。 */
export const CAT_FACE = { cx: 0, cy: -0.38, r: 0.56 } as const;

function inFace(p: Pt): boolean {
    return Math.hypot(p[0] - CAT_FACE.cx, p[1] - CAT_FACE.cy) < CAT_FACE.r;
}

/**
 * 轮廓上(不含脸和腿)按弧长等分的 n 个位置:返回所在笔画和点的下标。知识模式第一层挂在这些位置上:
 * 只用身子和尾巴,并跳过脸附近的点,免得节点和文字压在猫脸上。
 */
export function outlineAnchors(strokes: readonly CatStroke[], n: number): { stroke: number; index: number }[] {
    if (n <= 0) return [];
    const cand: { stroke: number; index: number; s: number }[] = [];
    let total = 0;
    strokes.forEach((st, si) => {
        if (st.part !== 'body' && st.part !== 'tail') return;
        let prev: Pt | null = null;
        st.points.forEach((p, i) => {
            if (inFace(p)) {
                prev = null;
                return;
            }
            if (prev) total += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
            prev = p;
            cand.push({ stroke: si, index: i, s: total });
        });
    });
    if (!cand.length) return [];
    return Array.from({ length: n }, (_, k) => {
        const target = ((k + 0.5) / n) * total;
        let lo = 0;
        let hi = cand.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cand[mid]!.s < target) lo = mid + 1;
            else hi = mid;
        }
        const c = cand[lo]!;
        return { stroke: c.stroke, index: c.index };
    });
}

/** 流动光在轮廓位置 u(0–1)处的亮度(0–1):一段沿轮廓走的光,走完一圈重来。 */
export function flowGlow(u: number, flowSpeed: number, tSec: number): number {
    if (flowSpeed <= 0) return 0;
    const head = (tSec * flowSpeed) % 1;
    let d = head - u;
    if (d < 0) d += 1;
    return d > 0.12 ? 0 : 1 - d / 0.12;
}
