// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 自然主视觉的知识模式:第一层挂在树的枝头上(树枝是分类);点亮一根树枝,光沿枝干流到枝头,其他部分变暗,
// 枝头长出一簇叶子(内容),每片叶子用细茎连回枝头;再往下一层同样在这个枝头展开。颜色全部来自主题 token。

import { expandedId, type KnowledgeNode, type KnowledgeScene, type ScreenNode } from '../knowledge-model.js';

export interface NatureKnowledgePalette {
    readonly branch: string;
    readonly leaf: string;
    readonly hit: string;
    readonly accent: string;
    readonly danger: string;
    readonly label: string;
    readonly font: string;
}

export interface NatureKnowledgeFrame {
    readonly w: number;
    readonly h: number;
    readonly radius: number;
    readonly tSec: number;
    /** 展开进度 0–1(减少动态时恒为 1)。 */
    readonly explode: number;
    /** 第一层第 i 个节点所在枝头的屏幕坐标。 */
    readonly rootAt: (i: number) => { x: number; y: number };
    /** 树根的屏幕坐标(叶簇朝背离树根的方向长)。 */
    readonly base: { x: number; y: number };
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** 子项不超过这个数时全部标名字;更多时只给命中、选中、焦点和分支标名字。 */
const LABEL_ALL = 36;
const MARGIN = 14;

function shortLabel(text: string, max = 14): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function ease(x: number): number {
    return 1 - (1 - x) ** 3;
}

/** 叶簇的中心:从枝头往背离树根的方向推一点,并留在画布里。 */
export function clusterCenter(
    anchor: { x: number; y: number },
    base: { x: number; y: number },
    radius: number,
    w: number,
    h: number,
) {
    const dx = anchor.x - base.x;
    const dy = anchor.y - base.y;
    const len = Math.hypot(dx, dy) || 1;
    const x = anchor.x + (dx / len) * radius * 0.18;
    const y = anchor.y + (dy / len) * radius * 0.18;
    const span = radius * 0.5;
    return {
        x: Math.min(w - span * 0.6, Math.max(span * 0.6, x)),
        y: Math.min(h - span * 0.5, Math.max(span * 0.5, y)),
    };
}

/** 第 i 片叶子相对叶簇中心的位置(未乘展开进度)。 */
export function leafOffset(i: number, n: number, radius: number, tSec: number) {
    const r = radius * (0.1 + 0.42 * Math.sqrt((i + 0.5) / Math.max(1, n)));
    const a = i * GOLDEN + tSec * 0.01;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.78, angle: a };
}

/** 画知识层,返回这一帧可点击的节点(屏幕坐标)。 */
export function drawNatureKnowledge(
    g: CanvasRenderingContext2D,
    scene: KnowledgeScene,
    frame: NatureKnowledgeFrame,
    p: NatureKnowledgePalette,
): ScreenNode[] {
    const out: ScreenNode[] = [];
    const open = expandedId(scene);
    const e = ease(Math.min(1, Math.max(0, frame.explode)));
    g.font = `12px ${p.font}`;
    g.textBaseline = 'middle';
    const clampX = (x: number) => Math.min(frame.w - MARGIN, Math.max(MARGIN, x));
    const clampY = (y: number) => Math.min(frame.h - MARGIN, Math.max(MARGIN, y));

    const node = (
        n: KnowledgeNode,
        x: number,
        y: number,
        r: number,
        alpha: number,
        label: boolean,
        shape: 'dot' | 'leaf',
        angle = 0,
    ) => {
        const hit = scene.hits.has(n.id);
        const color = hit ? p.hit : shape === 'leaf' ? p.leaf : p.branch;
        if (hit) {
            const glow = g.createRadialGradient(x, y, 0, x, y, r * 5);
            glow.addColorStop(0, p.hit);
            glow.addColorStop(1, 'transparent');
            g.globalAlpha = 0.35 * alpha;
            g.fillStyle = glow;
            g.beginPath();
            g.arc(x, y, r * 5, 0, Math.PI * 2);
            g.fill();
        }
        g.globalAlpha = alpha;
        g.fillStyle = color;
        g.beginPath();
        if (shape === 'leaf') g.ellipse(x, y, r * 1.7, r * 0.8, angle, 0, Math.PI * 2);
        else g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        g.lineWidth = 1;
        if (n.kind === 'branch' && shape === 'dot') {
            g.strokeStyle = color;
            g.globalAlpha = 0.5 * alpha;
            g.beginPath();
            g.arc(x, y, r + 3, 0, Math.PI * 2);
            g.stroke();
        }
        if (n.conflict) {
            g.strokeStyle = p.danger;
            g.globalAlpha = alpha;
            g.lineWidth = 1.5;
            g.beginPath();
            g.arc(x, y, r + 5, 0, Math.PI * 2);
            g.stroke();
        }
        if (n.id === scene.selectedId || n.id === scene.focusId) {
            g.strokeStyle = p.accent;
            g.globalAlpha = 1;
            g.lineWidth = 1.5;
            g.setLineDash(n.id === scene.selectedId ? [] : [3, 3]);
            g.beginPath();
            g.arc(x, y, r + 8, 0, Math.PI * 2);
            g.stroke();
            g.setLineDash([]);
        }
        if (label) {
            const text = shortLabel(n.label);
            // 右半边的文字写在点的左边,免得出画布
            const left = x > frame.w * 0.62;
            g.textAlign = left ? 'right' : 'left';
            g.globalAlpha = Math.min(1, alpha + 0.15);
            g.fillStyle = hit ? p.hit : p.label;
            g.fillText(text, left ? x - r - 6 : x + r + 6, y);
            g.textAlign = 'left';
        }
        g.globalAlpha = 1;
        if (alpha > 0.3) out.push({ id: n.id, x, y, r: Math.max(r + 6, 10) });
    };

    // 第一层:枝头上的金色光点;有展开时其余变暗
    const roots = scene.roots;
    const openRoot = scene.path[0]?.id ?? null;
    let anchor: { x: number; y: number } | null = null;
    roots.forEach((n, i) => {
        const pos = frame.rootAt(i);
        if (n.id === openRoot) {
            anchor = pos;
            return;
        }
        const dim = open ? 1 - 0.8 * e : 1;
        node(n, pos.x, pos.y, 3.6, 0.9 * dim, !open || dim > 0.5, 'dot');
    });
    if (!open || !anchor) return out;
    const a: { x: number; y: number } = anchor;

    // 叶簇:从枝头长出细茎连到每片叶子
    const c = clusterCenter(a, frame.base, frame.radius, frame.w, frame.h);
    const kids = scene.children;
    const pts = kids.map((_, i) => {
        const o = leafOffset(i, kids.length, frame.radius, frame.tSec);
        return {
            x: clampX(a.x + (c.x + o.x - a.x) * e),
            y: clampY(a.y + (c.y + o.y - a.y) * e),
            angle: o.angle,
        };
    });
    g.strokeStyle = p.branch;
    g.lineWidth = 1;
    g.globalAlpha = 0.22 * e;
    g.beginPath();
    pts.forEach((q, i) => {
        if (i >= 28) return;
        g.moveTo(a.x, a.y);
        g.quadraticCurveTo((a.x + q.x) / 2, Math.min(a.y, q.y) - 6, q.x, q.y);
    });
    g.stroke();
    g.globalAlpha = 1;

    const labelAll = kids.length <= LABEL_ALL;
    kids.forEach((n, i) => {
        const q = pts[i]!;
        const named =
            labelAll ||
            n.kind === 'branch' ||
            scene.hits.has(n.id) ||
            n.id === scene.selectedId ||
            n.id === scene.focusId;
        if (n.kind === 'branch') node(n, q.x, q.y, 3.2, 0.4 + 0.6 * e, named && e > 0.6, 'dot');
        else node(n, q.x, q.y, 2.6, 0.4 + 0.6 * e, named && e > 0.6, 'leaf', q.angle);
    });

    const center: KnowledgeNode = { id: open, label: scene.path[scene.path.length - 1]?.label ?? '', kind: 'branch' };
    node(center, a.x, a.y, 5.5, 1, true, 'dot');
    return out;
}
