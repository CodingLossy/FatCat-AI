// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆簇 / 会话地图共用的 Canvas 2D 渲染:节点(颜色、亮度、冲突描边)、连线、悬停名称、选中环。
// 点击选中、双击 / Enter 打开、方向键切换;不依赖第三方库,Canvas 不可用时返回 null,由调用方改用列表。

import { nextMapNode, pickMapNode, type MapDirection, type MapLayout } from './logic.js';

export interface MapCanvasOptions {
    onSelect?(id: string | null): void;
    onOpen?(id: string): void;
}

export interface MapCanvas {
    setLayout(layout: Pick<MapLayout, 'nodes' | 'edges'>): void;
    setSelected(id: string | null): void;
    resize(size: number): void;
    destroy(): void;
}

const EDGE = '#9aa3b2';
const SELECT = '#16a34a';
const OUTLINE = '#dc2626';
const LABEL = '#1f2937';

export function createMapCanvas(canvas: HTMLCanvasElement, options: MapCanvasOptions = {}): MapCanvas | null {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    let layout: Pick<MapLayout, 'nodes' | 'edges'> = { nodes: [], edges: [] };
    let size = canvas.clientWidth || 400;
    let selected: string | null = null;
    let hover: string | null = null;
    let raf = 0;

    function draw() {
        raf = 0;
        const c = ctx!;
        c.clearRect(0, 0, size, size);
        const at = new Map(layout.nodes.map((n) => [n.id, n]));
        c.strokeStyle = EDGE;
        c.lineWidth = 1.5;
        for (const e of layout.edges) {
            const a = at.get(e.from);
            const b = at.get(e.to);
            if (!a || !b) continue;
            c.beginPath();
            c.moveTo(a.x * size, a.y * size);
            c.lineTo(b.x * size, b.y * size);
            c.stroke();
        }
        for (const n of layout.nodes) {
            const r = Math.max(2, n.r * size);
            c.globalAlpha = n.alpha;
            c.fillStyle = n.color;
            c.beginPath();
            c.arc(n.x * size, n.y * size, r, 0, Math.PI * 2);
            c.fill();
            if (n.outline) {
                c.globalAlpha = 1;
                c.strokeStyle = OUTLINE;
                c.lineWidth = 2;
                c.stroke();
            }
        }
        c.globalAlpha = 1;
        const chosen = selected ? at.get(selected) : undefined;
        if (chosen) {
            c.strokeStyle = SELECT;
            c.lineWidth = 2.5;
            c.beginPath();
            c.arc(chosen.x * size, chosen.y * size, Math.max(2, chosen.r * size) + 4, 0, Math.PI * 2);
            c.stroke();
        }
        const focus = hover ? at.get(hover) : chosen;
        if (focus) {
            c.font = '13px system-ui, sans-serif';
            const w = Math.min(size - 8, c.measureText(focus.label).width + 12);
            const x = Math.min(Math.max(4, focus.x * size - w / 2), size - w - 4);
            const y = Math.max(4, focus.y * size - Math.max(2, focus.r * size) - 28);
            c.fillStyle = 'rgba(255,255,255,0.94)';
            c.fillRect(x, y, w, 20);
            c.fillStyle = LABEL;
            c.fillText(focus.label, x + 6, y + 14, w - 12);
        }
    }
    const redraw = () => {
        if (!raf) raf = requestAnimationFrame(draw);
    };
    function applySize() {
        const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
        canvas.width = Math.round(size * ratio);
        canvas.height = Math.round(size * ratio);
        canvas.style.height = `${size}px`;
        ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
        redraw();
    }
    applySize();

    const point = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        return { x: ((e.clientX - rect.left) / rect.width) * size, y: ((e.clientY - rect.top) / rect.height) * size };
    };
    const select = (id: string | null) => {
        if (id === selected) return;
        selected = id;
        options.onSelect?.(id);
        redraw();
    };
    const onMove = (e: MouseEvent) => {
        const p = point(e);
        const id = pickMapNode(layout.nodes, size, p.x, p.y);
        if (id !== hover) {
            hover = id;
            canvas.style.cursor = id ? 'pointer' : 'default';
            redraw();
        }
    };
    const onClick = (e: MouseEvent) => {
        const p = point(e);
        select(pickMapNode(layout.nodes, size, p.x, p.y));
    };
    const onDouble = (e: MouseEvent) => {
        const p = point(e);
        const id = pickMapNode(layout.nodes, size, p.x, p.y);
        if (id) options.onOpen?.(id);
    };
    const onLeave = () => {
        hover = null;
        redraw();
    };
    const onKey = (e: KeyboardEvent) => {
        const dir: Record<string, MapDirection> = {
            ArrowLeft: 'left',
            ArrowRight: 'right',
            ArrowUp: 'up',
            ArrowDown: 'down',
        };
        const d = dir[e.key];
        if (d) {
            e.preventDefault();
            select(nextMapNode(layout.nodes, selected, d));
        } else if (e.key === 'Enter' && selected) {
            e.preventDefault();
            options.onOpen?.(selected);
        }
    };
    canvas.tabIndex = 0;
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('dblclick', onDouble);
    canvas.addEventListener('keydown', onKey);

    return {
        setLayout(next) {
            layout = next;
            if (selected !== null && !layout.nodes.some((n) => n.id === selected)) selected = null;
            redraw();
        },
        setSelected(id) {
            selected = id;
            redraw();
        },
        resize(next) {
            size = Math.max(160, Math.round(next));
            applySize();
        },
        destroy() {
            if (raf) cancelAnimationFrame(raf);
            canvas.removeEventListener('mousemove', onMove);
            canvas.removeEventListener('mouseleave', onLeave);
            canvas.removeEventListener('click', onClick);
            canvas.removeEventListener('dblclick', onDouble);
            canvas.removeEventListener('keydown', onKey);
        },
    };
}
