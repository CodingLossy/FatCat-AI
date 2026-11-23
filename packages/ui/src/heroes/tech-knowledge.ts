// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 科技主视觉的知识模式:第一层是星球里的一圈亮星(记忆三类 + 知识顶层分类);点亮一颗星,它移到中心并炸开成
// 带名字的星座网(子项沿黄金角螺旋排开,彼此用细线连成星座);再往下一层同样。颜色全部来自主题 token。

import {
    bubbleBox,
    expandedId,
    type KnowledgeNode,
    type KnowledgeScene,
    type LabelCandidate,
    placeLabels,
    type ScreenNode,
} from '../knowledge-model.js';

export interface KnowledgePalette {
    readonly star: string;
    readonly hit: string;
    readonly accent: string;
    readonly danger: string;
    readonly line: string;
    readonly label: string;
    readonly font: string;
}

export interface KnowledgeFrame {
    readonly cx: number;
    readonly cy: number;
    /** 星球半径(CSS 像素)。 */
    readonly radius: number;
    readonly tSec: number;
    /** 炸开进度 0–1(减少动态时恒为 1)。 */
    readonly explode: number;
    /** 当前展开节点从哪里飞到中心(上一帧它在屏幕上的位置)。 */
    readonly from: { x: number; y: number } | null;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** 子项不超过这个数时全部标名字;更多时只给命中、选中、焦点和分支标名字,避免文字糊成一片。 */
const LABEL_ALL = 40;

/** 第一层节点在星球内一圈椭圆上的位置(随时间缓慢漂移)。 */
export function rootPosition(i: number, n: number, f: Pick<KnowledgeFrame, 'cx' | 'cy' | 'radius' | 'tSec'>) {
    const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2 + f.tSec * 0.02;
    return { x: f.cx + Math.cos(a) * f.radius * 0.62, y: f.cy + Math.sin(a) * f.radius * 0.5, depth: Math.sin(a) };
}

/** 第 i 个子项在星座网里的位置(相对中心,未乘炸开进度)。 */
export function childOffset(i: number, n: number, radius: number, tSec: number) {
    const r = radius * (0.24 + 0.72 * Math.sqrt((i + 0.5) / Math.max(1, n)));
    const a = i * GOLDEN + tSec * 0.015;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.82 };
}

export function shortLabel(text: string, max = 16): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 标签的优先级:悬停 / 焦点总显示,其次是展开的中心、命中、分支,最后是普通子项(靠前的先放)。 */
export function labelPriority(
    scene: KnowledgeScene,
    n: KnowledgeNode,
    base: number,
): { priority: number; always: boolean } {
    const always = n.id === scene.hoverId || n.id === scene.focusId;
    const priority = always ? 1000 : base + (scene.hits.has(n.id) ? 200 : 0) + (n.kind === 'branch' ? 100 : 0);
    return { priority, always };
}

/**
 * 依次放下标签并画出来。选中的节点只显示气泡,不再画同样的文字;其他标签避开气泡,
 * 放不下先截短,再放不下就只在悬停时显示。
 */
export function drawLabels(
    g: CanvasRenderingContext2D,
    scene: KnowledgeScene,
    cands: readonly (LabelCandidate & { color: string; alpha: number })[],
    screen: readonly ScreenNode[],
    extraAvoid: readonly { x: number; y: number; w: number; h: number }[] = [],
): void {
    const sel = scene.selectedId ? screen.find((n) => n.id === scene.selectedId) : undefined;
    const avoid = [...extraAvoid, ...(sel ? [bubbleBox(sel, scene.bubble)] : [])];
    const byId = new Map(cands.map((c) => [c.id, c]));
    const placed = placeLabels(
        cands.filter((c) => c.id !== scene.selectedId),
        (text) => g.measureText(text).width,
        avoid,
        shortLabel,
    );
    for (const l of placed) {
        const c = byId.get(l.id);
        if (!c) continue;
        g.textAlign = l.align;
        g.globalAlpha = c.alpha;
        g.fillStyle = c.color;
        g.fillText(l.shown, l.x, l.y);
    }
    g.textAlign = 'left';
    g.globalAlpha = 1;
}

function ease(x: number): number {
    return 1 - (1 - x) ** 3;
}

/** 画知识层,返回这一帧可点击的节点(屏幕坐标),给拾取和气泡定位用。 */
export function drawTechKnowledge(
    g: CanvasRenderingContext2D,
    scene: KnowledgeScene,
    frame: KnowledgeFrame,
    p: KnowledgePalette,
): ScreenNode[] {
    const out: ScreenNode[] = [];
    const labels: (LabelCandidate & { color: string; alpha: number })[] = [];
    const open = expandedId(scene);
    const e = ease(Math.min(1, Math.max(0, frame.explode)));
    g.font = `12px ${p.font}`;
    g.textBaseline = 'middle';

    const node = (n: KnowledgeNode, x: number, y: number, r: number, alpha: number, label: boolean, rank = 0) => {
        const hit = scene.hits.has(n.id);
        const color = hit ? p.hit : p.star;
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
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        g.lineWidth = 1;
        if (n.kind === 'branch') {
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
        if (label || n.id === scene.hoverId || n.id === scene.focusId) {
            labels.push({
                id: n.id,
                text: shortLabel(n.label),
                x: x + r + 6,
                y,
                align: 'left',
                ...labelPriority(scene, n, rank),
                color: hit ? p.hit : p.label,
                alpha: Math.min(1, alpha + 0.15),
            });
        }
        g.globalAlpha = 1;
        if (alpha > 0.3) out.push({ id: n.id, x, y, r: Math.max(r + 6, 10) });
    };

    // 第一层:一圈亮星;有展开时其余变暗,展开的那颗飞到中心
    const roots = scene.roots;
    roots.forEach((n, i) => {
        if (n.id === open && scene.path.length === 1) return;
        const pos = rootPosition(i, roots.length, frame);
        const dim = open ? 1 - 0.85 * e : 1;
        const r = 3.2 + 1.6 * ((pos.depth + 1) / 2);
        node(n, pos.x, pos.y, r, (0.55 + 0.45 * ((pos.depth + 1) / 2)) * dim, !open || dim > 0.5, 50);
    });
    if (!open) {
        drawLabels(g, scene, labels, out);
        return out;
    }

    // 展开的节点在中心
    const center: KnowledgeNode = { id: open, label: scene.path[scene.path.length - 1]?.label ?? '', kind: 'branch' };
    const fx = frame.from?.x ?? frame.cx;
    const fy = frame.from?.y ?? frame.cy;
    const cx = fx + (frame.cx - fx) * e;
    const cy = fy + (frame.cy - fy) * e;

    // 星座网:子项到中心的细线,以及每个子项连向它之前最近的一个,形成一簇簇星座
    const kids = scene.children;
    const pts = kids.map((_, i) => {
        const o = childOffset(i, kids.length, frame.radius, frame.tSec);
        return { x: cx + o.x * e, y: cy + o.y * e };
    });
    g.strokeStyle = p.line;
    g.lineWidth = 1;
    g.globalAlpha = 0.18 * e;
    g.beginPath();
    pts.forEach((q, i) => {
        if (i < 18) {
            g.moveTo(cx, cy);
            g.lineTo(q.x, q.y);
        }
        let best = -1;
        let bestD = Infinity;
        for (let j = Math.max(0, i - 6); j < i; j++) {
            const d = Math.hypot(pts[j]!.x - q.x, pts[j]!.y - q.y);
            if (d < bestD) {
                bestD = d;
                best = j;
            }
        }
        if (best >= 0 && bestD < frame.radius * 0.45) {
            g.moveTo(pts[best]!.x, pts[best]!.y);
            g.lineTo(q.x, q.y);
        }
    });
    g.stroke();
    g.globalAlpha = 1;

    const labelAll = kids.length <= LABEL_ALL;
    kids.forEach((n, i) => {
        const q = pts[i]!;
        const r = n.kind === 'branch' ? 3.4 : 2.4;
        const named =
            labelAll ||
            n.kind === 'branch' ||
            scene.hits.has(n.id) ||
            n.id === scene.selectedId ||
            n.id === scene.focusId;
        node(n, q.x, q.y, r, 0.35 + 0.65 * e, named && e > 0.6, -i / kids.length);
    });
    node(center, cx, cy, 5.5, 1, true, 500);
    drawLabels(g, scene, labels, out);
    return out;
}
