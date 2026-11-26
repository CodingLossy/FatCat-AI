// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 自然主视觉:夜色里一棵发光的大树(厚树干、蓬松的冷白树冠、树心和根部的蓝白光)。
// 说话时花瓣和光点随音量落下,树冠光晕稍强。知识模式仍用原来的枝干结构。帧循环与科技共用。

import { expandedId, type KnowledgeScene, pickNode, type ScreenNode } from '../knowledge-model.js';
import { compactDisplay, type OrbState } from '../orb-model.js';
import type { Hero, HeroMode, HeroOptions } from '../theme.js';
import { addTick, currentQuality, fitCanvas, prefersReducedMotion } from '../voice-orb.js';
import { type AnchoredKnowledgePalette, drawAnchoredKnowledge } from './anchored-knowledge.js';
import {
    branchChain,
    climbGlow,
    createLeafField,
    leafAlpha,
    leafCap,
    natureLook,
    natureTree,
    stepLeaves,
    swayOffset,
    tipsFor,
    TREE_BASE,
} from './nature-model.js';
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

/** 自然主题的状态色(tokens.css 缺失时的后备):聆听淡青白、检测到语音嫩绿、思考淡紫、说话亮蓝。 */
const NATURE_STATES: StateColors = {
    listening: [226, 243, 234],
    heard: [142, 240, 110],
    thinking: [195, 154, 242],
    speaking: [74, 156, 255],
};

interface Palette {
    trunk: string;
    canopy: string;
    root: string;
    mist: string;
    firefly: string;
    states: StateColors;
    knowledge: AnchoredKnowledgePalette;
}

function readPalette(el: HTMLElement): Palette {
    const cs = getComputedStyle(el);
    const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    const trunk = get('--nature-trunk', '#e8c27a');
    const canopy = get('--nature-canopy', '#a6d99a');
    return {
        trunk,
        canopy,
        root: get('--nature-root', '#e8c27a'),
        mist: get('--nature-mist', '#a6d99a'),
        firefly: get('--nature-firefly', '#e9f29b'),
        states: readStateColors((name) => cs.getPropertyValue(name), 'nature', NATURE_STATES),
        knowledge: {
            branch: trunk,
            leaf: canopy,
            hit: get('--nature-firefly', '#e9f29b'),
            accent: get('--accent', '#e8c27a'),
            danger: get('--danger', '#e5857f'),
            label: get('--fg', '#e6efe0'),
            font: get('--font-sans', 'system-ui, sans-serif'),
        },
    };
}

const TREE = natureTree();
const BUCKETS = 4;

/** 树冠上几团蓬松的光,树空间坐标 [x, y, 半径比例, 颜色]。 */
const CANOPY_BLOBS: readonly [number, number, number, string][] = [
    [0, -0.34, 0.46, '#f7fbff'],
    [-0.32, -0.2, 0.34, '#d5e4ff'],
    [0.34, -0.18, 0.34, '#f6e4ee'],
    [-0.12, -0.55, 0.28, '#eef6ff'],
    [0.18, -0.52, 0.26, '#f8eef4'],
    [-0.48, -0.05, 0.24, '#c5d8f4'],
    [0.5, -0.04, 0.24, '#e4eefc'],
    [0, -0.08, 0.3, '#f4f8ff'],
    [-0.2, -0.4, 0.22, '#ffffff'],
    [0.22, -0.38, 0.22, '#f3e4ee'],
    [0.05, -0.28, 0.2, '#e7f2ff'],
];

const PETAL_COLORS = ['#f7fbff', '#f3dce8', '#c9ddff'] as const;

const AMBIENT_MOTES: readonly { x: number; y: number; phase: number }[] = [
    { x: -0.55, y: -0.15, phase: 0.4 },
    { x: 0.5, y: -0.35, phase: 1.7 },
    { x: -0.2, y: -0.62, phase: 2.4 },
    { x: 0.22, y: 0.05, phase: 3.1 },
    { x: -0.48, y: 0.15, phase: 4.2 },
    { x: 0.08, y: -0.48, phase: 5.0 },
];

function softBlob(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
    const grd = g.createRadialGradient(x, y, r * 0.08, x, y, r);
    grd.addColorStop(0, color);
    grd.addColorStop(0.28, color);
    grd.addColorStop(1, 'transparent');
    g.globalAlpha = alpha;
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
}

/** 助手模式下的夜树:薄雾、一抹地面、厚树干、发光树冠。知识模式不走这里。 */
function paintAncestral(
    g: CanvasRenderingContext2D,
    w: number,
    h: number,
    cx: number,
    cy: number,
    R: number,
    X: (x: number, y: number) => number,
    Y: (y: number) => number,
    pulse: number,
    tint: string | null,
): void {
    // 夜色薄雾,边缘淡出,不铺成一块方底板
    const dusk = g.createRadialGradient(cx, cy - R * 0.05, R * 0.05, cx, cy, R * 1.25);
    dusk.addColorStop(0, 'rgba(18, 52, 74, 0.72)');
    dusk.addColorStop(0.55, 'rgba(10, 28, 42, 0.35)');
    dusk.addColorStop(1, 'transparent');
    g.globalAlpha = 1;
    g.fillStyle = dusk;
    g.fillRect(0, 0, w, h);

    // 一点地面和水面,以及根部光的倒影
    g.fillStyle = '#101820';
    g.globalAlpha = 0.72;
    g.beginPath();
    g.ellipse(cx, cy + R * 0.86, R * 0.95, R * 0.11, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0c1822';
    g.globalAlpha = 0.28;
    g.fillRect(0, cy + R * 0.9, w, Math.max(0, h - (cy + R * 0.9)));

    const baseX = X(0, 0.72);
    const baseY = Y(0.72);
    softBlob(g, baseX, baseY + R * 0.22, R * 0.22, '#7eb6ff', 0.18);

    g.fillStyle = '#3a2c24';
    g.globalAlpha = 0.96;
    g.beginPath();
    g.moveTo(X(-0.1, -0.08), Y(-0.08));
    g.bezierCurveTo(X(-0.16, 0.2), Y(0.2), X(-0.24, 0.46), Y(0.46), X(-0.32, 0.74), Y(0.74));
    g.lineTo(X(0.3, 0.74), Y(0.74));
    g.bezierCurveTo(X(0.2, 0.46), Y(0.46), X(0.12, 0.2), Y(0.2), X(0.1, -0.08), Y(-0.08));
    g.closePath();
    g.fill();
    g.strokeStyle = '#5c4636';
    g.lineWidth = Math.max(1, R * 0.012);
    g.globalAlpha = 0.45;
    g.beginPath();
    g.moveTo(X(-0.02, 0.1), Y(0.1));
    g.lineTo(X(-0.03, 0.62), Y(0.62));
    g.moveTo(X(0.03, 0.05), Y(0.05));
    g.lineTo(X(0.05, 0.58), Y(0.58));
    g.stroke();
    g.strokeStyle = '#3a2c24';
    g.lineWidth = Math.max(2, R * 0.045);
    g.lineCap = 'round';
    g.globalAlpha = 0.9;
    g.beginPath();
    g.moveTo(X(-0.02, 0.02), Y(0.02));
    g.quadraticCurveTo(X(-0.18, -0.06), Y(-0.06), X(-0.34, -0.16), Y(-0.16));
    g.moveTo(X(0.02, 0.0), Y(0.0));
    g.quadraticCurveTo(X(0.2, -0.08), Y(-0.08), X(0.36, -0.14), Y(-0.14));
    g.stroke();

    const crown = 0.78 + 0.22 * pulse;
    for (const [x, y, rad, color] of CANOPY_BLOBS) {
        softBlob(g, X(x, y), Y(y), R * rad * (0.82 + 0.08 * pulse), color, Math.min(0.9, crown));
    }
    const coreX = X(0, -0.34);
    const coreY = Y(-0.34);
    softBlob(g, coreX, coreY, R * (0.2 + 0.07 * pulse), '#f4fbff', 0.85);
    softBlob(g, coreX, coreY, R * (0.1 + 0.04 * pulse), '#9fd0ff', 0.9);
    if (tint) softBlob(g, coreX, coreY, R * 0.28, tint, 0.22 * pulse);
    softBlob(g, baseX, baseY, R * 0.07, '#d7ecff', 0.85);
}

export function createNatureHero(canvas: HTMLCanvasElement, options: HeroOptions): Hero | null {
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
    let tint: Tint = { color: NATURE_STATES.listening, amount: 0 };
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
    // 知识层的漂移时间:有选中的节点(气泡打开)时停住
    let layoutT = 0;
    let lastLayoutMs = 0;
    // 平滑后的电平,摇动不跳
    let smooth = 0;
    let leaves = createLeafField();
    /** 树冠光晕,待机也有一层,说话时随音量加强。 */
    let pulse = 0.4;

    const draw = (nowMs: number) => {
        if (!reduced && ++frames % 120 === 0) palette = readPalette(canvas);
        const t = reduced ? 2.4 : (nowMs - start) / 1000;
        const frameDt = lastMs ? Math.min(100, nowMs - lastMs) : 0;
        smooth += ((level ?? 0) - smooth) * 0.2;
        const knowledge = mode === 'knowledge';
        const look = natureLook(state, reduced ? 0 : smooth, knowledge);
        // 状态色染在树冠光点和萤火上(枝干保持金色);知识模式不染色
        tint = stepTint(tint, knowledge ? 'idle' : heroState, palette.states, frameDt, reduced || !lastMs);
        lastMs = nowMs;
        const tinted = (base: string) => {
            const rgb = parseColor(base);
            // 互补色按比例混合会发灰:按最高比例归一,聆听时也基本是状态色
            return rgb && tint.amount > 0.01 ? rgbString(mixRgb(rgb, tint.color, tint.amount / 0.75)) : base;
        };
        const fit = fitCanvas(canvas);
        if (!fit) return;
        const { ctx: g, w, h } = fit;
        const R = Math.min(w, h) * 0.46;
        const cx = w / 2;
        const cy = h / 2;
        const scale = Math.min(1, R / 220);
        const display = globalThis.screen;
        const screenShort = display ? Math.min(display.width, display.height) : undefined;
        const compact = compactDisplay(Math.min(w, h), screenShort) || scale < 0.55;
        leaves = stepLeaves(
            leaves,
            frameDt,
            state === 'speaking' && !knowledge,
            reduced ? 0 : smooth,
            reduced ? 0 : leafCap(compact),
            reduced,
        );
        const sway = reduced ? 0 : look.sway;
        const X = (x: number, y: number) => cx + (x + swayOffset(y, sway, t)) * R;
        const Y = (y: number) => cy + y * R;

        // 知识模式里点亮的那根枝:它的整条枝链保持亮,其余变暗
        const tips = knowledge && scene ? tipsFor(TREE, scene.roots.length) : [];
        const openRoot = knowledge && scene ? (scene.path[0]?.id ?? null) : null;
        const openIndex = openRoot && scene ? scene.roots.findIndex((n) => n.id === openRoot) : -1;
        const openTip = openIndex >= 0 ? tips[openIndex] : undefined;
        const chain = openTip === undefined ? null : new Set(branchChain(TREE, openTip));
        const flow = reduced ? 1 : Math.min(1, (nowMs - explodeAt) / 700);
        const lit = (branch: number) => !chain || chain.has(branch);
        const dimOthers = chain ? 0.28 : 1;
        const bx = X(TREE_BASE.x, TREE_BASE.y);
        const by = Y(TREE_BASE.y);
        if (!reduced && !knowledge) {
            const target = state === 'speaking' ? 0.38 + 0.62 * Math.min(1, smooth) : 0.4;
            const k = frameDt <= 0 ? 1 : 1 - Math.exp(-frameDt / 260);
            pulse += (target - pulse) * k;
        }
        if (!knowledge) {
            paintAncestral(g, w, h, cx, cy, R, X, Y, pulse, tint.amount > 0.08 ? rgbString(tint.color) : null);
        }

        // 知识模式仍画原来的枝干,好让节点挂得上。助手模式用上面的夜树。
        if (knowledge) {
            // 低处薄雾:几团横向缓慢漂移的雾
            for (let k = 0; k < 3; k++) {
                const mx = cx + Math.sin(t * 0.05 + k * 2.1) * R * 0.5;
                const my = cy + R * (0.72 + k * 0.08);
                g.save();
                g.translate(mx, my);
                g.scale(1, 0.28);
                const mist = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.9);
                mist.addColorStop(0, palette.mist);
                mist.addColorStop(1, 'transparent');
                g.globalAlpha = 0.07;
                g.fillStyle = mist;
                g.beginPath();
                g.arc(0, 0, R * 0.9, 0, Math.PI * 2);
                g.fill();
                g.restore();
            }

            // 根部微光和根须
            const glow = g.createRadialGradient(bx, by, 0, bx, by, R * 0.35);
            glow.addColorStop(0, palette.root);
            glow.addColorStop(1, 'transparent');
            g.globalAlpha = 0.22 * look.brightness * (chain ? 1 : 0.9 + 0.1 * Math.sin(t * 1.3));
            g.fillStyle = glow;
            g.beginPath();
            g.arc(bx, by, R * 0.35, 0, Math.PI * 2);
            g.fill();
            g.strokeStyle = palette.root;
            g.lineWidth = Math.max(0.6, 1.2 * scale);
            g.globalAlpha = 0.35 * look.brightness;
            g.beginPath();
            for (const r of TREE.roots) {
                g.moveTo(cx + r.x0 * R, Y(r.y0));
                g.lineTo(cx + r.x1 * R, Y(r.y1));
            }
            g.stroke();

            // 细光线:每根枝一条线,外层越细
            g.strokeStyle = palette.trunk;
            for (let d = 0; d <= 6; d++) {
                g.lineWidth = Math.max(0.5, 2.2 * 0.72 ** d * Math.max(0.5, scale));
                g.globalAlpha = (0.32 - d * 0.03) * look.brightness;
                g.beginPath();
                TREE.branches.forEach((b, i) => {
                    if (b.depth !== d) return;
                    g.globalAlpha = (0.32 - d * 0.03) * look.brightness * (lit(i) ? 1 : dimOthers);
                    g.moveTo(X(b.x0, b.y0), Y(b.y0));
                    g.lineTo(X(b.x1, b.y1), Y(b.y1));
                });
                g.stroke();
            }

            // 知识模式:光沿点亮的枝链流到枝头
            if (chain && openTip !== undefined) {
                const top = TREE.branches[openTip]?.h1 ?? 1;
                const reach = top * flow;
                g.strokeStyle = palette.trunk;
                g.lineWidth = Math.max(1, 2 * scale);
                g.globalAlpha = 0.9;
                g.beginPath();
                for (const i of chain) {
                    const b = TREE.branches[i];
                    if (!b || b.h0 > reach) continue;
                    const u = Math.min(1, (reach - b.h0) / Math.max(1e-6, b.h1 - b.h0));
                    const ex = b.x0 + (b.x1 - b.x0) * u;
                    const ey = b.y0 + (b.y1 - b.y0) * u;
                    g.moveTo(X(b.x0, b.y0), Y(b.y0));
                    g.lineTo(X(ex, ey), Y(ey));
                }
                g.stroke();
            }

            // 光点:枝干金色、树冠浅绿,按透明度档合并路径;小画布和低画质时减少
            const quality = currentQuality().quality * Math.max(0.2, scale);
            const dotPaths = (color: 'trunk' | 'canopy') => {
                const paths: Path2D[] = [];
                for (let i = 0; i < BUCKETS; i++) paths.push(new Path2D());
                const dots = color === 'trunk' ? TREE.trunkDots : TREE.canopyDots;
                const n = Math.round(dots.length * Math.min(1, quality));
                for (let i = 0; i < n; i++) {
                    const s = dots[i];
                    if (!s) break;
                    const x = X(s.x, s.y);
                    const y = Y(s.y);
                    const twinkle =
                        color === 'canopy' ? 1 - look.shimmer * (0.5 + 0.5 * Math.sin(s.phase + t * 2.3)) : 1;
                    const climb = reduced ? 0 : climbGlow(s.h, look.climb, t);
                    const alpha =
                        Math.min(1, (0.35 + 0.65 * s.size) * twinkle * look.brightness + climb * 0.7) *
                        (lit(s.branch) ? 1 : dimOthers);
                    const bucket = Math.min(BUCKETS - 1, Math.floor(alpha * BUCKETS));
                    const size = (0.5 + s.size * (color === 'canopy' ? 1.5 : 1.1) + climb * 0.8) * Math.max(0.5, scale);
                    const path = paths[bucket];
                    path?.moveTo(x + size, y);
                    path?.arc(x, y, size, 0, Math.PI * 2);
                }
                g.fillStyle = color === 'trunk' ? palette.trunk : tinted(palette.canopy);
                paths.forEach((path, i) => {
                    g.globalAlpha = (i + 0.7) / BUCKETS;
                    g.fill(path);
                });
            };
            dotPaths('trunk');
            dotPaths('canopy');
        }
        g.globalAlpha = 1;

        // 说话时的光瓣,以及待机时少数慢慢飘的光点。减少动态时落叶清空,光点停住。
        if (!knowledge) {
            AMBIENT_MOTES.forEach((mote, i) => {
                const dx = reduced ? 0 : Math.sin(t * 0.32 + mote.phase) * 0.05;
                const dy = reduced ? 0 : Math.cos(t * 0.24 + mote.phase) * 0.035;
                softBlob(g, X(mote.x + dx, mote.y + dy), Y(mote.y + dy), R * 0.035, PETAL_COLORS[i % 3]!, 0.55);
            });
            leaves.leaves.forEach((leaf, i) => {
                if (!leaf.active) return;
                const alpha = leafAlpha(leaf.y);
                if (alpha <= 0) return;
                const px = cx + leaf.x * R;
                const py = cy + leaf.y * R;
                const color = PETAL_COLORS[i % 3]!;
                softBlob(g, px, py, (7 + leaf.size * 6) * Math.max(0.6, scale), color, alpha * 0.35);
                g.save();
                g.translate(px, py);
                g.rotate(leaf.phase + leaf.age);
                g.fillStyle = color;
                g.globalAlpha = alpha * 0.9;
                g.beginPath();
                g.ellipse(
                    0,
                    0,
                    (3.2 + leaf.size * 3.2) * Math.max(0.6, scale),
                    (1.6 + leaf.size) * Math.max(0.6, scale),
                    0,
                    0,
                    Math.PI * 2,
                );
                g.fill();
                g.restore();
            });
        }
        g.globalAlpha = 1;

        // 知识模式:枝头节点、叶簇
        if (knowledge && scene) {
            if (!reduced && lastLayoutMs && !scene.selectedId) layoutT += Math.min(0.1, (nowMs - lastLayoutMs) / 1000);
            lastLayoutMs = nowMs;
            screen = drawAnchoredKnowledge(
                g,
                scene,
                {
                    w,
                    h,
                    radius: R,
                    tSec: layoutT,
                    explode: reduced ? 1 : (nowMs - explodeAt - 250) / 650,
                    base: { x: bx, y: by },
                    style: 'leaf',
                    rootAt: (i) => {
                        const b = TREE.branches[tips[i] ?? -1];
                        return b ? { x: X(b.x1, b.y1), y: Y(b.y1) } : { x: cx, y: cy };
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
