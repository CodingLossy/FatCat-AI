// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆簇与会话地图的纯逻辑(ADR 0044 第 6 节):布局、颜色 / 亮度、命中测试、键盘邻居。不碰 DOM。

export interface MapNode {
    id: string;
    /** 归一化坐标 0–1(渲染时按画布尺寸缩放)。 */
    x: number;
    y: number;
    /** 半径,相对画布边长(0–1)。 */
    r: number;
    color: string;
    /** 0–1,记忆里表示置信度与分层。 */
    alpha: number;
    /** 冲突描边(记忆)。 */
    outline: boolean;
    label: string;
}

export interface MapEdge {
    from: string;
    to: string;
}

export interface MapGroup {
    key: string;
    x: number;
    y: number;
    count: number;
}

export interface MapLayout {
    nodes: MapNode[];
    edges: MapEdge[];
    groups: MapGroup[];
}

/** 三种记忆类型的颜色:浅色与深色背景上对比度都 ≥ 3:1。 */
export const MEMORY_COLORS: Readonly<Record<string, string>> = {
    semantic: '#2563eb',
    episodic: '#d97706',
    procedural: '#7c3aed',
};
const FALLBACK_COLOR = '#7a8699';

export interface MemoryLike {
    id: string;
    text: string;
    memType: string;
    status: string;
    confidence: number;
    tier?: string | undefined;
    pinned?: boolean | undefined;
}

/** 亮度 = 置信度 × 分层权重(active 1、cold 0.7、archive 0.45),钉住的至少 0.8;已更替 / 撤回 / 过期很淡。 */
export function memoryAlpha(m: Pick<MemoryLike, 'confidence' | 'tier' | 'pinned' | 'status'>): number {
    const tier = m.tier === 'archive' ? 0.45 : m.tier === 'cold' ? 0.7 : 1;
    let a = 0.25 + 0.75 * Math.min(1, Math.max(0, m.confidence)) * tier;
    if (m.pinned) a = Math.max(a, 0.8);
    if (m.status === 'superseded' || m.status === 'retracted' || m.status === 'expired') a = Math.min(a, 0.25);
    return Math.min(1, a);
}

function fit(points: { x: number; y: number }[]): void {
    if (points.length === 0) return;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY, 1e-9);
    const margin = 0.08;
    const scale = (1 - 2 * margin) / span;
    const offX = (1 - (maxX - minX) * scale) / 2;
    const offY = (1 - (maxY - minY) * scale) / 2;
    for (const p of points) {
        p.x = (p.x - minX) * scale + offX;
        p.y = (p.y - minY) * scale + offY;
    }
}

/**
 * 记忆簇:按 memType 分簇,簇心均匀摆在圆环上(只有一簇时在中心),簇内用向日葵螺旋排开。
 * 颜色按类型,亮度见 memoryAlpha,冲突(status 为 conflicted 或在 conflictedIds 里)描边。
 */
export function memoryLayout(
    memories: readonly MemoryLike[],
    conflictedIds: ReadonlySet<string> = new Set(),
): MapLayout {
    const types = [...new Set(memories.map((m) => m.memType))].sort();
    const byType = new Map<string, MemoryLike[]>(types.map((t) => [t, []]));
    for (const m of memories) byType.get(m.memType)!.push(m);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const spacing = 1;
    const biggest = Math.max(1, ...[...byType.values()].map((l) => l.length));
    const ring = types.length > 1 ? Math.sqrt(biggest) * spacing * 2.2 : 0;
    const raw: { id: string; x: number; y: number; m: MemoryLike }[] = [];
    const groups: MapGroup[] = [];
    types.forEach((type, ti) => {
        const angle = (2 * Math.PI * ti) / Math.max(1, types.length) - Math.PI / 2;
        const cx = Math.cos(angle) * ring;
        const cy = Math.sin(angle) * ring;
        const list = byType.get(type)!;
        groups.push({ key: type, x: cx, y: cy, count: list.length });
        list.forEach((m, i) => {
            const rad = Math.sqrt(i + 0.5) * spacing;
            raw.push({ id: m.id, x: cx + Math.cos(i * golden) * rad, y: cy + Math.sin(i * golden) * rad, m });
        });
    });
    const all = [...raw, ...groups];
    fit(all);
    const r = Math.min(0.03, Math.max(0.006, 0.45 / Math.sqrt(Math.max(1, memories.length)) / 4));
    return {
        nodes: raw.map(({ id, x, y, m }) => ({
            id,
            x,
            y,
            r,
            color: MEMORY_COLORS[m.memType] ?? FALLBACK_COLOR,
            alpha: memoryAlpha(m),
            outline: m.status === 'conflicted' || conflictedIds.has(m.id),
            label: m.text.length > 60 ? `${m.text.slice(0, 60)}…` : m.text,
        })),
        edges: [],
        groups,
    };
}

export interface SessionLike {
    id: string;
    title: string;
    forkedFromSessionId: string | null;
    forkedFromMessageId: string | null;
}

/**
 * 会话地图:只画有 fork 关系的会话(自己是分叉或被分叉),按分叉深度从上到下、同层从左到右排成森林;
 * 其余是「独立会话」,只返回个数。父会话不在传入列表里的分叉按根处理。
 */
export function forkForest(sessions: readonly SessionLike[]): MapLayout & { standalone: number } {
    const ids = new Set(sessions.map((s) => s.id));
    const parentOf = (s: SessionLike) =>
        s.forkedFromSessionId && ids.has(s.forkedFromSessionId) ? s.forkedFromSessionId : null;
    const children = new Map<string, SessionLike[]>();
    for (const s of sessions) {
        const p = parentOf(s);
        if (p) children.set(p, [...(children.get(p) ?? []), s]);
    }
    const related = sessions.filter((s) => s.forkedFromSessionId !== null || children.has(s.id));
    const relatedSet = new Set(related.map((s) => s.id));
    const roots = related.filter((s) => parentOf(s) === null);
    const pos = new Map<string, { x: number; y: number }>();
    let leaf = 0;
    const place = (s: SessionLike, depth: number, seen: Set<string>) => {
        if (seen.has(s.id)) return;
        seen.add(s.id);
        const kids = (children.get(s.id) ?? []).filter((k) => relatedSet.has(k.id));
        if (kids.length === 0) {
            pos.set(s.id, { x: leaf++, y: depth });
            return;
        }
        for (const k of kids) place(k, depth + 1, seen);
        const xs = kids.map((k) => pos.get(k.id)?.x ?? 0);
        pos.set(s.id, { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: depth });
    };
    const seen = new Set<string>();
    for (const root of roots) place(root, 0, seen);
    const points = [...pos.values()];
    const maxDepth = Math.max(0, ...points.map((p) => p.y));
    // 横向与纵向分别拉伸,避免只有一两层时挤在一条线上。
    const maxX = Math.max(0, ...points.map((p) => p.x));
    const norm = (p: { x: number; y: number }) => ({
        x: maxX === 0 ? 0.5 : 0.08 + (p.x / maxX) * 0.84,
        y: maxDepth === 0 ? 0.5 : 0.08 + (p.y / maxDepth) * 0.84,
    });
    const r = Math.min(0.035, Math.max(0.012, 0.5 / Math.sqrt(Math.max(1, points.length)) / 3));
    const nodes: MapNode[] = related
        .filter((s) => pos.has(s.id))
        .map((s) => {
            const p = norm(pos.get(s.id)!);
            return {
                id: s.id,
                ...p,
                r,
                color: s.forkedFromSessionId ? '#2563eb' : '#16a34a',
                alpha: 1,
                outline: false,
                label: s.title || '—',
            };
        });
    const edges: MapEdge[] = nodes
        .map((n) => related.find((s) => s.id === n.id)!)
        .filter((s) => parentOf(s) !== null && pos.has(parentOf(s)!))
        .map((s) => ({ from: parentOf(s)!, to: s.id }));
    return { nodes, edges, groups: [], standalone: sessions.length - related.length };
}

/** 命中测试:坐标是画布像素;取离指针最近且在半径(至少 10 像素)内的节点。 */
export function pickMapNode(nodes: readonly MapNode[], size: number, px: number, py: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const n of nodes) {
        const d = Math.hypot(n.x * size - px, n.y * size - py);
        if (d <= Math.max(10, n.r * size) && d < bestD) {
            best = n.id;
            bestD = d;
        }
    }
    return best;
}

export type MapDirection = 'left' | 'right' | 'up' | 'down';

/** 键盘导航:朝箭头方向找最近的节点;没有当前选中则选最靠左上的;没有候选时保持不动。 */
export function nextMapNode(nodes: readonly MapNode[], currentId: string | null, dir: MapDirection): string | null {
    if (nodes.length === 0) return null;
    const current = nodes.find((n) => n.id === currentId);
    if (!current) return nodes.reduce((a, b) => (b.y + b.x < a.y + a.x ? b : a)).id;
    const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
    const dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const n of nodes) {
        if (n.id === current.id) continue;
        const along = (n.x - current.x) * dx + (n.y - current.y) * dy;
        if (along <= 1e-9) continue;
        const across = Math.abs((n.x - current.x) * dy) + Math.abs((n.y - current.y) * dx);
        const score = along + across * 1.5;
        if (score < bestScore) {
            best = n.id;
            bestScore = score;
        }
    }
    return best ?? current.id;
}
