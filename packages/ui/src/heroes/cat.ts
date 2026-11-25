// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 猫咪主视觉:奶油底上一只橘色单线条线稿坐猫,线上缀着小光点。聆听时耳朵动、思考时尾巴摆、说话时光顺着轮廓流动。
// 颜色来自 tokens.css 的 --cat-* 变量;帧循环与科技共用(后台降帧、隐藏暂停、减少动态时静态一帧)。

import { expandedId, type KnowledgeScene, pickNode, type ScreenNode } from '../knowledge-model.js';
import type { OrbState } from '../orb-model.js';
import type { Hero, HeroMode, HeroOptions } from '../theme.js';
import { addTick, currentQuality, fitCanvas, prefersReducedMotion } from '../voice-orb.js';
import { type AnchoredKnowledgePalette, drawAnchoredKnowledge } from './anchored-knowledge.js';
import { CAT_FACE, catPose, catStrokes, catWhiskers, flowGlow, outlineAnchors, posePoint } from './cat-model.js';
import {
    type HeroState,
    mixRgb,
    motionState,
    parseColor,
    readStateColors,
    rgbString,
    type StateColors,
    stepTint,
    type Tint,
} from './state-tint.js';

interface Palette {
    line: string;
    spark: string;
    core: string;
    whisker: string;
    states: StateColors;
    knowledge: AnchoredKnowledgePalette;
}

function readPalette(el: HTMLElement): Palette {
    const cs = getComputedStyle(el);
    const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    const line = get('--cat-line', '#f28c38');
    return {
        line,
        spark: get('--cat-spark', '#ffb061'),
        core: get('--cat-spark-core', '#ffffff'),
        whisker: get('--cat-whisker', '#3b2a20'),
        states: readStateColors((name) => cs.getPropertyValue(name), 'cat', CAT_STATES),
        knowledge: {
            branch: line,
            leaf: get('--cat-paw', '#f6b6b0'),
            hit: get('--cat-spark', '#ffb061'),
            accent: get('--accent', '#f28c38'),
            danger: get('--danger', '#c2413b'),
            label: get('--fg', '#3b2a20'),
            font: get('--font-sans', 'system-ui, sans-serif'),
        },
    };
}

/** 猫主题的状态色(tokens.css 缺失时的后备):奶油底上要看得清,所以比深色主题更深、更饱和。 */
const CAT_STATES: StateColors = {
    listening: [91, 155, 216],
    heard: [31, 157, 85],
    thinking: [138, 79, 216],
    speaking: [31, 95, 214],
};

const STROKES = catStrokes();
const WHISKERS = catWhiskers();
/** 每个轮廓点在整条轮廓(不含脸)上的位置 0–1,给流动光用;脸上的点为 -1。 */
const OUTLINE_U: number[][] = (() => {
    let total = 0;
    const raw = STROKES.map((st) => {
        if (st.part === 'face') return st.points.map(() => -1);
        return st.points.map((p, i) => {
            const prev = st.points[i - 1];
            if (prev) total += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
            return total;
        });
    });
    return raw.map((list) => list.map((s) => (s < 0 ? -1 : s / (total || 1))));
})();
const SPARK_EVERY = 4;

export function createCatHero(canvas: HTMLCanvasElement, options: HeroOptions): Hero | null {
    let probe: CanvasRenderingContext2D | null;
    try {
        probe = canvas.getContext('2d');
    } catch {
        probe = null;
    }
    if (!probe) return null;
    const reduced = options.reducedMotion ?? prefersReducedMotion();
    let state: OrbState = 'idle';
    let heroState: HeroState = 'idle';
    let tint: Tint = { color: CAT_STATES.listening, amount: 0 };
    let lastMs = 0;
    let mode: HeroMode = 'assistant';
    let level: number | null = null;
    let palette = readPalette(canvas);
    let destroyed = false;
    let frames = 0;
    const start = performance.now();
    let scene: KnowledgeScene | null = null;
    let screen: ScreenNode[] = [];
    let explodeAt = 0;
    let layoutT = 0;
    let lastLayoutMs = 0;
    let smooth = 0;

    const draw = (nowMs: number) => {
        if (!reduced && ++frames % 120 === 0) palette = readPalette(canvas);
        const t = reduced ? 0 : (nowMs - start) / 1000;
        smooth += ((level ?? 0) - smooth) * 0.2;
        const knowledge = mode === 'knowledge';
        const pose = catPose(state, reduced ? 0 : smooth, t, knowledge);
        // 状态色染在轮廓线和光点的光晕上(亮芯与胡须不变);知识模式不染色
        tint = stepTint(
            tint,
            knowledge ? 'idle' : heroState,
            palette.states,
            lastMs ? Math.min(100, nowMs - lastMs) : 0,
            reduced || !lastMs,
        );
        lastMs = nowMs;
        const tinted = (base: string) => {
            const rgb = parseColor(base);
            // 互补色按比例混合会发灰:按最高比例归一,聆听时也基本是状态色
            return rgb && tint.amount > 0.01 ? rgbString(mixRgb(rgb, tint.color, tint.amount / 0.75)) : base;
        };
        const line = tinted(palette.line);
        const spark = tinted(palette.spark);
        const fit = fitCanvas(canvas);
        if (!fit) return;
        const { ctx: g, w, h } = fit;
        const R = Math.min(w, h) * 0.44;
        const cx = w / 2;
        const cy = h / 2;
        const scale = Math.min(1, R / 220);
        const open = knowledge && scene ? expandedId(scene) : null;
        // 知识模式里猫退到后面:整体淡一些,展开后更淡,文字压在上面也清楚
        const dim = knowledge ? (open ? 0.3 : 0.55) : 1;
        const S = (part: Parameters<typeof posePoint>[0], p: readonly [number, number]) => {
            const q = posePoint(part, p, pose);
            return [cx + q[0] * R, cy + q[1] * R] as const;
        };

        g.lineCap = 'round';
        g.lineJoin = 'round';

        // 胡须
        g.strokeStyle = palette.whisker;
        g.lineWidth = Math.max(0.6, 1 * scale);
        g.globalAlpha = 0.35 * dim;
        g.beginPath();
        for (const [a, b] of WHISKERS) {
            const p = S('head', a);
            const q = S('head', b);
            g.moveTo(p[0], p[1]);
            g.lineTo(q[0], q[1]);
        }
        g.stroke();

        // 单线条轮廓
        g.strokeStyle = line;
        g.lineWidth = Math.max(1.2, 2.4 * scale);
        g.globalAlpha = (0.55 + 0.45 * pose.brightness) * dim;
        g.beginPath();
        for (const st of STROKES) {
            st.points.forEach((p, i) => {
                const q = S(st.part, p);
                if (i) g.lineTo(q[0], q[1]);
                else g.moveTo(q[0], q[1]);
            });
        }
        g.stroke();

        // 说话:一段光顺着轮廓流动
        if (!reduced && pose.flow > 0) {
            g.strokeStyle = spark;
            g.lineWidth = Math.max(2, 3.6 * scale);
            STROKES.forEach((st, si) => {
                const us = OUTLINE_U[si] ?? [];
                for (let i = 1; i < st.points.length; i++) {
                    const u = us[i] ?? -1;
                    if (u < 0) continue;
                    const glow = flowGlow(u, pose.flowSpeed, t);
                    if (glow <= 0) continue;
                    const a = S(st.part, st.points[i - 1]!);
                    const b = S(st.part, st.points[i]!);
                    g.globalAlpha = glow * pose.flow;
                    g.beginPath();
                    g.moveTo(a[0], a[1]);
                    g.lineTo(b[0], b[1]);
                    g.stroke();
                }
            });
        }

        // 线上缀的小光点(低画质时隔得更开)
        const every = Math.round(SPARK_EVERY / Math.max(0.35, currentQuality().quality * Math.max(0.5, scale)));
        STROKES.forEach((st, si) => {
            if (st.part === 'face') return;
            const us = OUTLINE_U[si] ?? [];
            for (let i = 0; i < st.points.length; i += every) {
                const q = S(st.part, st.points[i]!);
                const twinkle = reduced ? 0.7 : 0.5 + 0.5 * Math.sin(i * 1.7 + si + t * 2.1);
                const flow = reduced ? 0 : flowGlow(us[i] ?? -1, pose.flowSpeed, t) * pose.flow;
                const r = (1.2 + 0.6 * twinkle + 1.4 * flow) * Math.max(0.6, scale);
                const a = (0.35 + 0.5 * twinkle * pose.brightness + 0.3 * flow) * dim;
                // 一圈暖色光晕 + 亮芯,在奶油底上也看得出是「光点」
                g.fillStyle = spark;
                g.globalAlpha = 0.45 * a;
                g.beginPath();
                g.arc(q[0], q[1], r * 2.6, 0, Math.PI * 2);
                g.fill();
                g.fillStyle = palette.core;
                g.globalAlpha = Math.min(1, a + 0.2);
                g.beginPath();
                g.arc(q[0], q[1], r, 0, Math.PI * 2);
                g.fill();
            }
        });
        g.globalAlpha = 1;

        // 知识模式:轮廓上的光点是第一层,点开后像胡须一样拉出细线连到子项
        if (knowledge && scene) {
            if (!reduced && lastLayoutMs && !scene.selectedId) layoutT += Math.min(0.1, (nowMs - lastLayoutMs) / 1000);
            lastLayoutMs = nowMs;
            const anchors = outlineAnchors(STROKES, scene.roots.length);
            screen = drawAnchoredKnowledge(
                g,
                scene,
                {
                    w,
                    h,
                    radius: R,
                    tSec: layoutT,
                    explode: reduced ? 1 : (nowMs - explodeAt) / 650,
                    // 子项簇背离猫脸,长到身子和尾巴外侧
                    base: { x: cx + CAT_FACE.cx * R, y: cy + CAT_FACE.cy * R },
                    avoid: { x: cx + CAT_FACE.cx * R, y: cy + CAT_FACE.cy * R, r: CAT_FACE.r * R },
                    style: 'whisker',
                    rootAt: (i) => {
                        const a = anchors[i];
                        const st = a ? STROKES[a.stroke] : undefined;
                        const p = st?.points[a!.index];
                        if (!st || !p) return { x: cx, y: cy };
                        const q = S(st.part, p);
                        return { x: q[0], y: q[1] };
                    },
                },
                palette.knowledge,
            );
        } else screen = [];
        g.globalAlpha = 1;
    };

    draw(performance.now());
    const remove = reduced ? () => undefined : addTick(draw);
    const root = canvas.ownerDocument?.documentElement ?? null;
    let observer: MutationObserver | null = null;
    if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(() => {
            palette = readPalette(canvas);
            if (reduced) draw(performance.now());
        });
        observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    }

    return {
        setState(next) {
            if (destroyed) return;
            heroState = next;
            state = motionState(next);
            if (reduced) draw(performance.now());
        },
        setLevel(next) {
            level = next;
        },
        setMode(next) {
            if (destroyed) return;
            mode = next;
            if (reduced) draw(performance.now());
        },
        setScene(next) {
            if (destroyed) return;
            const before = scene ? expandedId(scene) : null;
            const after = next ? expandedId(next) : null;
            if (after !== before) explodeAt = performance.now();
            scene = next;
            if (reduced) draw(performance.now());
        },
        pick(x, y) {
            return pickNode(screen, x, y);
        },
        locate(id) {
            const n = screen.find((s) => s.id === id);
            return n ? { x: n.x, y: n.y } : null;
        },
        destroy() {
            destroyed = true;
            remove();
            observer?.disconnect();
        },
    };
}
