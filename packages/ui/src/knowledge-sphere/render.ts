// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 知识地图粒子球的 Canvas 2D 渲染(ADR 0044 第 5 节)。不依赖第三方库,与 VoiceOrb 一致:
// 拖动旋转、点击选中、双击 / Enter 打开(下钻或查看内容)、方向键切换选中、Esc 交回调用方(返回上一层)。
// 一次只画当前分类的子项,所以点数就是该分类的子项数;页面不可见时暂停,减少动态效果时不自转。

import {
    clampPitch,
    layoutNodes,
    neighbor,
    pickNode,
    project,
    rotationToFront,
    type Direction,
    type Projected,
    type SphereItem,
    type SphereNode,
} from './logic.js';

export interface KnowledgeSphereOptions {
    /** 不给时读取 prefers-reduced-motion。 */
    reducedMotion?: boolean;
    onSelect?(id: string | null): void;
    onOpen?(id: string): void;
    onBack?(): void;
}

export interface KnowledgeSphere {
    setItems(items: readonly SphereItem[]): void;
    setSelected(id: string | null): void;
    resize(size: number): void;
    /** 立即画一帧,返回耗时毫秒(性能测试用)。 */
    renderOnce(): number;
    destroy(): void;
}

const COLORS = {
    category: '#d97706',
    content: '#2563eb',
    selected: '#16a34a',
    label: '#1f2937',
} as const;

/** Canvas 2D 不可用时返回 null,由调用方改用列表。 */
export function createKnowledgeSphere(
    canvas: HTMLCanvasElement,
    options: KnowledgeSphereOptions = {},
): KnowledgeSphere | null {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const reduced =
        options.reducedMotion ??
        (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

    let nodes: SphereNode[] = [];
    let labels = new Map<string, string>();
    let projected: Projected[] = [];
    let selected: string | null = null;
    let hover: string | null = null;
    let yaw = 0.4;
    let pitch = -0.25;
    let size = canvas.clientWidth || 400;
    let dragging: { x: number; y: number; moved: boolean } | null = null;
    let raf = 0;
    let last = 0;
    let dirty = true;

    function applySize() {
        const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
        canvas.width = Math.round(size * ratio);
        canvas.height = Math.round(size * ratio);
        canvas.style.height = `${size}px`;
        ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
        dirty = true;
    }
    applySize();

    function draw(): number {
        const started = performance.now();
        projected = project(nodes, { yaw, pitch, size });
        const c = ctx!;
        c.clearRect(0, 0, size, size);
        // 先画背面(淡),再画正面。
        for (const pass of [0, 1]) {
            c.globalAlpha = pass === 0 ? 0.25 : 0.95;
            for (const p of projected) {
                if ((p.depth >= 0 ? 1 : 0) !== pass) continue;
                c.fillStyle = p.category ? COLORS.category : COLORS.content;
                if (p.radius < 1.5) c.fillRect(p.x - 0.75, p.y - 0.75, 1.5, 1.5);
                else {
                    c.beginPath();
                    c.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                    c.fill();
                }
            }
        }
        c.globalAlpha = 1;
        const focus = projected.find((p) => p.id === (hover ?? selected));
        const chosen = projected.find((p) => p.id === selected);
        if (chosen) {
            c.strokeStyle = COLORS.selected;
            c.lineWidth = 2;
            c.beginPath();
            c.arc(chosen.x, chosen.y, Math.max(6, chosen.radius + 4), 0, Math.PI * 2);
            c.stroke();
        }
        if (focus) {
            const text = labels.get(focus.id) ?? '';
            c.font = '13px system-ui, sans-serif';
            const w = c.measureText(text).width + 12;
            const x = Math.min(Math.max(4, focus.x - w / 2), size - w - 4);
            const y = Math.max(4, focus.y - focus.radius - 26);
            c.fillStyle = 'rgba(255,255,255,0.92)';
            c.fillRect(x, y, w, 20);
            c.fillStyle = COLORS.label;
            c.fillText(text, x + 6, y + 14);
        }
        dirty = false;
        return performance.now() - started;
    }

    function frame(t: number) {
        raf = requestAnimationFrame(frame);
        if (document.hidden) return;
        const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
        last = t;
        if (!reduced && !dragging && hover === null && selected === null) {
            yaw += dt * 0.15;
            dirty = true;
        }
        if (dirty) draw();
    }
    raf = requestAnimationFrame(frame);

    function point(e: PointerEvent | MouseEvent) {
        const rect = canvas.getBoundingClientRect();
        return { x: ((e.clientX - rect.left) / rect.width) * size, y: ((e.clientY - rect.top) / rect.height) * size };
    }
    function select(id: string | null) {
        if (id === selected) return;
        selected = id;
        dirty = true;
        options.onSelect?.(id);
    }
    const onDown = (e: PointerEvent) => {
        dragging = { x: e.clientX, y: e.clientY, moved: false };
        canvas.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
        if (dragging) {
            const dx = e.clientX - dragging.x;
            const dy = e.clientY - dragging.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
            yaw += dx * 0.008;
            pitch = clampPitch(pitch + dy * 0.008);
            dragging.x = e.clientX;
            dragging.y = e.clientY;
            dirty = true;
            return;
        }
        const p = point(e);
        const id = pickNode(projected, p.x, p.y);
        if (id !== hover) {
            hover = id;
            canvas.style.cursor = id ? 'pointer' : 'grab';
            dirty = true;
        }
    };
    const onUp = (e: PointerEvent) => {
        const wasClick = dragging !== null && !dragging.moved;
        dragging = null;
        if (wasClick) {
            const p = point(e);
            select(pickNode(projected, p.x, p.y));
        }
    };
    const onLeave = () => {
        hover = null;
        dirty = true;
    };
    const onDouble = (e: MouseEvent) => {
        const p = point(e);
        const id = pickNode(projected, p.x, p.y);
        if (id) options.onOpen?.(id);
    };
    const onKey = (e: KeyboardEvent) => {
        const dir: Record<string, Direction> = {
            ArrowLeft: 'left',
            ArrowRight: 'right',
            ArrowUp: 'up',
            ArrowDown: 'down',
        };
        const d = dir[e.key];
        if (d) {
            e.preventDefault();
            const next = neighbor(projected, selected, d);
            if (next) select(next);
        } else if (e.key === 'Enter' && selected) {
            e.preventDefault();
            options.onOpen?.(selected);
        } else if (e.key === 'Escape' || e.key === 'Backspace') {
            e.preventDefault();
            options.onBack?.();
        } else return;
        // 选中的点在背面时转到正面,键盘用户总能看到当前项。
        const node = nodes.find((n) => n.id === selected);
        if (node && projected.find((p) => p.id === selected)!.depth < 0) {
            const rot = rotationToFront(node.pos);
            yaw = rot.yaw;
            pitch = rot.pitch;
        }
        dirty = true;
    };
    canvas.style.cursor = 'grab';
    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('dblclick', onDouble);
    canvas.addEventListener('keydown', onKey);

    return {
        setItems(items) {
            nodes = layoutNodes(items);
            labels = new Map(items.map((i) => [i.id, i.label]));
            if (selected !== null && !labels.has(selected)) selected = null;
            dirty = true;
        },
        setSelected(id) {
            selected = id;
            dirty = true;
        },
        resize(next) {
            size = Math.max(160, Math.round(next));
            applySize();
        },
        renderOnce: draw,
        destroy() {
            cancelAnimationFrame(raf);
            canvas.removeEventListener('pointerdown', onDown);
            canvas.removeEventListener('pointermove', onMove);
            canvas.removeEventListener('pointerup', onUp);
            canvas.removeEventListener('pointerleave', onLeave);
            canvas.removeEventListener('dblclick', onDouble);
            canvas.removeEventListener('keydown', onKey);
        },
    };
}
