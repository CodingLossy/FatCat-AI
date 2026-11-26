// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 猫咪主视觉:奶油底上一只近黑毛笔的圆润简笔猫。聆听时耳朵动、思考时尾巴摆、说话时 ω 嘴微微张开。
// 颜色来自 tokens.css;帧循环与科技共用(后台降帧、隐藏暂停、减少动态时静态一帧)。轮廓上不画节点。

import { expandedId, type KnowledgeScene, pickNode, type ScreenNode } from '../knowledge-model.js';
import type { OrbState } from '../orb-model.js';
import type { Hero, HeroMode, HeroOptions } from '../theme.js';
import { addTick, fitCanvas, prefersReducedMotion } from '../voice-orb.js';
import { type AnchoredKnowledgePalette, drawAnchoredKnowledge } from './anchored-knowledge.js';
import {
    bubbleOpacity,
    CAT_FACE,
    type CatPart,
    catMouth,
    catPose,
    catStrokes,
    createBubbles,
    MEOW_TEXT,
    outlineAnchors,
    posePoint,
    stepBubbles,
} from './cat-model.js';
import {
    type HeroState,
    motionState,
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
    fg: string;
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
        fg: get('--fg', '#3b2a20'),
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
/** 毛笔墨色,奶油底上远高于 4.5:1。状态色只做外圈淡晕,不把猫涂成蓝线。 */
const INK = '#241c16';
const PAPER = '#fffdf8';

function inkWidth(part: CatPart, scale: number): number {
    if (part === 'face' || part === 'legs') return Math.max(2.2, 4.4 * scale);
    return Math.max(4.2, 8.2 * scale);
}

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
    /** 嘴张开的程度,跟着音量缓动,说话结束再合上。 */
    let mouthEase = 0;
    let bubbles = createBubbles();

    const draw = (nowMs: number) => {
        if (!reduced && ++frames % 120 === 0) palette = readPalette(canvas);
        const t = reduced ? 0 : (nowMs - start) / 1000;
        const frameDt = lastMs ? Math.min(100, nowMs - lastMs) : 0;
        smooth += ((level ?? 0) - smooth) * 0.2;
        const knowledge = mode === 'knowledge';
        const pose = catPose(state, reduced ? 0 : smooth, t, knowledge);
        // 状态色染在轮廓线和光点的光晕上(亮芯与胡须不变);知识模式不染色
        tint = stepTint(tint, knowledge ? 'idle' : heroState, palette.states, frameDt, reduced || !lastMs);
        lastMs = nowMs;
        const mouthTarget = reduced || knowledge ? 0 : pose.mouth;
        const mouthK = frameDt <= 0 ? 1 : 1 - Math.exp(-frameDt / 140);
        mouthEase += (mouthTarget - mouthEase) * mouthK;
        if (mouthEase < 0.001 && mouthTarget === 0) mouthEase = 0;
        bubbles = stepBubbles(bubbles, frameDt, state === 'speaking' && !knowledge, reduced ? 0 : smooth, reduced);
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

        const trace = (part: CatPart, points: readonly (readonly [number, number])[]) => {
            points.forEach((p, i) => {
                const q = S(part, p);
                if (i) g.lineTo(q[0], q[1]);
                else g.moveTo(q[0], q[1]);
            });
        };

        // 身子填一层很浅的纸色,笔触仍是空心的简笔
        const body = STROKES.find((st) => st.part === 'body');
        if (body) {
            g.beginPath();
            trace('body', body.points);
            g.closePath();
            g.fillStyle = PAPER;
            g.globalAlpha = 0.94 * dim;
            g.fill();
        }

        // 状态色只留一圈淡晕
        if (tint.amount > 0.04) {
            g.strokeStyle = rgbString(tint.color);
            g.globalAlpha = 0.28 * tint.amount * dim;
            for (const st of STROKES) {
                if (st.part === 'face' || st.part === 'legs') continue;
                g.lineWidth = inkWidth(st.part, scale) * 1.7;
                g.beginPath();
                trace(st.part, st.points);
                g.stroke();
            }
        }

        g.strokeStyle = INK;
        g.globalAlpha = (0.92 + 0.08 * pose.brightness) * dim;
        for (const st of STROKES) {
            g.lineWidth = inkWidth(st.part, scale);
            g.beginPath();
            trace(st.part, st.points);
            g.stroke();
        }

        // 说话时 ω 下面多一笔下唇,仍是墨线,不填实心
        const lips = catMouth(mouthEase);
        if (lips.length > 0) {
            g.strokeStyle = INK;
            g.lineWidth = inkWidth('face', scale);
            g.globalAlpha = 0.95 * dim;
            g.beginPath();
            for (const lip of lips) trace('face', lip);
            g.stroke();
        }
        g.globalAlpha = 1;

        // 偶尔在头旁边冒出「喵~」。可可棕字写在白底上,对比度沿用正文。减少动态时没有气泡。
        if (!reduced && bubbles.bubbles.length > 0) {
            const fontPx = Math.round(18 * Math.max(0.9, scale));
            g.font = `600 ${fontPx}px ${palette.knowledge.font}`;
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            for (const b of bubbles.bubbles) {
                const alpha = bubbleOpacity(b.age, b.life);
                if (alpha <= 0) continue;
                const px = cx + b.x * R;
                const py = cy + (b.y - b.age * 0.06) * R;
                const tw = g.measureText(MEOW_TEXT).width;
                const padX = 10;
                const bh = fontPx + 10;
                const bw = tw + padX * 2;
                const x0 = px - bw / 2;
                const y0 = py - bh / 2;
                const r = bh / 2;
                g.beginPath();
                g.moveTo(x0 + r, y0);
                g.arcTo(x0 + bw, y0, x0 + bw, y0 + bh, r);
                g.arcTo(x0 + bw, y0 + bh, x0, y0 + bh, r);
                g.arcTo(x0, y0 + bh, x0, y0, r);
                g.arcTo(x0, y0, x0 + bw, y0, r);
                g.closePath();
                g.fillStyle = '#ffffff';
                g.strokeStyle = palette.fg;
                g.lineWidth = 1;
                g.globalAlpha = alpha;
                g.fill();
                g.stroke();
                g.fillStyle = palette.fg;
                g.fillText(MEOW_TEXT, px, py + 0.5);
            }
        }
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
