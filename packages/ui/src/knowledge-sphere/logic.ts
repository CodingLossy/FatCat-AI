// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 知识地图粒子球的纯逻辑(ADR 0044 第 5 节):布局、投影、命中测试、键盘邻居、是否改用列表。
// 不碰 DOM,所以可以直接单测;渲染在 render.ts。

import { fibonacciSphere, type Point3 } from '../orb-model.js';

export interface SphereItem {
    id: string;
    /** 悬停 / 选中时显示的名称。 */
    label: string;
    /** 用来决定点的大小,通常是 descendantCount;越大点越大。 */
    weight: number;
    /** 分类显示成实心大点,内容条目显示成小点。 */
    category: boolean;
}

export interface SphereNode extends SphereItem {
    pos: Point3;
}

/** 按给定顺序把条目均匀摆在单位球面上。 */
export function layoutNodes(items: readonly SphereItem[]): SphereNode[] {
    const points = fibonacciSphere(items.length);
    return items.map((item, i) => ({ ...item, pos: points[i]! }));
}

export interface View {
    /** 绕竖直轴的旋转(弧度)。 */
    yaw: number;
    /** 绕水平轴的俯仰(弧度),限制在 ±1.2。 */
    pitch: number;
    /** 画布边长(CSS 像素)。 */
    size: number;
}

export interface Projected {
    id: string;
    x: number;
    y: number;
    /** 数值越大越靠近观察者(−1 到 1)。 */
    depth: number;
    /** 屏幕上的半径(像素)。 */
    radius: number;
    category: boolean;
}

export function clampPitch(pitch: number): number {
    return Math.max(-1.2, Math.min(1.2, pitch));
}

/** 点大小:按权重的对数缩放到 [min, max] 像素,再按深度远小近大。 */
export function nodeRadius(weight: number, category: boolean, size: number, depth: number): number {
    const base = (category ? 0.018 : 0.009) * size;
    const grow = category ? Math.min(1, Math.log10(1 + Math.max(0, weight)) / 4) * 0.02 * size : 0;
    return (base + grow) * (0.75 + 0.25 * depth);
}

export function project(nodes: readonly SphereNode[], view: View): Projected[] {
    const cy = Math.cos(view.yaw);
    const sy = Math.sin(view.yaw);
    const cp = Math.cos(view.pitch);
    const sp = Math.sin(view.pitch);
    const half = view.size / 2;
    const reach = half * 0.82;
    return nodes.map((node) => {
        const [x, y, z] = node.pos;
        const x1 = x * cy + z * sy;
        const z1 = -x * sy + z * cy;
        const y2 = y * cp - z1 * sp;
        const z2 = y * sp + z1 * cp;
        return {
            id: node.id,
            x: half + x1 * reach,
            y: half - y2 * reach,
            depth: z2,
            radius: nodeRadius(node.weight, node.category, view.size, z2),
            category: node.category,
        };
    });
}

/** 命中测试:只考虑朝向观察者的一面(depth ≥ 0),取离指针最近且在半径(至少 8 像素)内的点。 */
export function pickNode(projected: readonly Projected[], px: number, py: number): string | null {
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const p of projected) {
        if (p.depth < 0) continue;
        const d = Math.hypot(p.x - px, p.y - py);
        if (d <= Math.max(8, p.radius) && d < bestDistance) {
            best = p.id;
            bestDistance = d;
        }
    }
    return best;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/** 键盘导航:朝箭头方向、在正面的点里找最近的;没有候选时保持不动。没有当前选中则选最靠近正中的点。 */
export function neighbor(projected: readonly Projected[], currentId: string | null, dir: Direction): string | null {
    const front = projected.filter((p) => p.depth >= 0);
    if (front.length === 0) return currentId;
    const current = currentId === null ? undefined : projected.find((p) => p.id === currentId);
    if (!current) {
        const mid = front.reduce((a, b) => (b.depth > a.depth ? b : a));
        return mid.id;
    }
    const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
    const dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const p of front) {
        if (p.id === current.id) continue;
        const ax = (p.x - current.x) * dx + (p.y - current.y) * dy;
        if (ax <= 0) continue;
        const across = Math.abs((p.x - current.x) * dy) + Math.abs((p.y - current.y) * dx);
        const score = ax + across * 1.5;
        if (score < bestScore) {
            best = p.id;
            bestScore = score;
        }
    }
    return best ?? current.id;
}

/** 让选中的点转到正面:返回需要的 yaw / pitch(用于键盘选中背面的点后转过来)。 */
export function rotationToFront(pos: Point3): { yaw: number; pitch: number } {
    const [x, y, z] = pos;
    const yaw = -Math.atan2(x, z);
    const z1 = -x * Math.sin(yaw) + z * Math.cos(yaw);
    const pitch = clampPitch(Math.atan2(y, z1));
    return { yaw, pitch };
}

/** 没有 Canvas 2D、或用户要求减少动态效果时,改用列表视图。 */
export function shouldUseList(options: { canvasAvailable: boolean; reducedMotion: boolean }): boolean {
    return !options.canvasAvailable || options.reducedMotion;
}
