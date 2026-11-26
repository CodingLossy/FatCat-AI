// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 自然主视觉:夜色里一棵树。助手模式是一根有纹理的树干加一整片发光的树冠(不是一串光球);
// 知识模式仍用原来的枝干。说话时花瓣随音量落下。帧循环与科技共用。

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

/** 树冠内部的小叶片,固定种子,裁在同一片树冠里,不是一颗颗光球。 */
const CROWN_LEAVES: readonly { x: number; y: number; rot: number; w: number; tint: number }[] = (() => {
    let a = 11;
    const rnd = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return Array.from({ length: 260 }, () => {
        const ang = rnd() * Math.PI * 2;
        const rad = Math.sqrt(rnd()) * 0.92;
        return {
            x: Math.cos(ang) * 0.52 * rad,
            y: -0.3 + Math.sin(ang) * 0.36 * rad,
            rot: rnd() * Math.PI,
            w: 0.012 + rnd() * 0.018,
            tint: rnd(),
        };
    });
})();

const IDLE_MOTES: readonly { x: number; y: number; phase: number }[] = [
    { x: -0.62, y: -0.22, phase: 0.4 },
    { x: 0.58, y: -0.4, phase: 1.6 },
    { x: -0.15, y: -0.72, phase: 2.5 },
    { x: 0.28, y: -0.05, phase: 3.4 },
    { x: -0.4, y: 0.08, phase: 4.6 },
];

/** 一整片树冠的轮廓:边缘有叶状起伏,但是一条闭合的线。 */
function traceCrown(
    g: CanvasRenderingContext2D,
    X: (x: number, y: number) => number,
    Y: (y: number) => number,
    pulse: number,
): void {
    const cy0 = -0.3;
    const n = 36;
    g.beginPath();
    for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const lobe = 1 + 0.045 * Math.sin(i * 2.2) + 0.02 * Math.sin(i * 5.3);
        const grow = 1 + 0.025 * pulse;
        const x = Math.cos(a) * 0.62 * lobe * grow;
        const y = cy0 + Math.sin(a) * 0.4 * lobe * grow;
        if (i === 0) {
            g.moveTo(X(x, y), Y(y));
            continue;
        }
        const am = ((i - 0.5) / n) * Math.PI * 2 - Math.PI / 2;
        const mx = Math.cos(am) * 0.68 * grow;
        const my = cy0 + Math.sin(am) * 0.44 * grow;
        g.quadraticCurveTo(X(mx, my), Y(my), X(x, y), Y(y));
    }
    g.closePath();
}

function paintRealTree(
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
    reduced: boolean,
    t: number,
): void {
    const dusk = g.createRadialGradient(cx, cy - R * 0.1, R * 0.1, cx, cy, R * 1.35);
    dusk.addColorStop(0, 'rgba(14, 40, 58, 0.55)');
    dusk.addColorStop(0.7, 'rgba(8, 22, 34, 0.22)');
    dusk.addColorStop(1, 'transparent');
    g.globalAlpha = 1;
    g.fillStyle = dusk;
    g.fillRect(0, 0, w, h);

    g.fillStyle = '#101820';
    g.globalAlpha = 0.55;
    g.beginPath();
    g.ellipse(cx, cy + R * 0.9, R * 0.9, R * 0.07, 0, 0, Math.PI * 2);
    g.fill();

    // 树干:下宽上窄,有树皮纹,中间一条竖着的冷光
    g.fillStyle = '#3d2e26';
    g.globalAlpha = 1;
    g.beginPath();
    g.moveTo(X(-0.09, -0.02), Y(-0.02));
    g.bezierCurveTo(X(-0.14, 0.22), Y(0.22), X(-0.2, 0.5), Y(0.5), X(-0.26, 0.78), Y(0.78));
    g.lineTo(X(0.24, 0.78), Y(0.78));
    g.bezierCurveTo(X(0.16, 0.5), Y(0.5), X(0.1, 0.22), Y(0.22), X(0.08, -0.02), Y(-0.02));
    g.closePath();
    g.fill();
    g.save();
    g.clip();
    g.strokeStyle = '#2a1e18';
    g.lineWidth = Math.max(1, R * 0.012);
    g.globalAlpha = 0.55;
    g.beginPath();
    for (const x0 of [-0.08, -0.02, 0.05, 0.12]) {
        g.moveTo(X(x0, 0.05), Y(0.05));
        g.quadraticCurveTo(X(x0 * 1.3, 0.4), Y(0.4), X(x0 * 1.8, 0.75), Y(0.75));
    }
    g.stroke();
    const vein = g.createLinearGradient(X(-0.04, 0), Y(0), X(0.04, 0), Y(0));
    vein.addColorStop(0, 'transparent');
    vein.addColorStop(0.5, 'rgba(210, 232, 255, 0.85)');
    vein.addColorStop(1, 'transparent');
    g.globalAlpha = 0.55 + 0.25 * pulse;
    g.fillStyle = vein;
    g.fillRect(X(-0.035, -0.02), Y(-0.02), R * 0.07, Y(0.78) - Y(-0.02));
    g.restore();

    // 根部一小团光,贴在树干里,不是一颗球
    const baseX = X(0, 0.7);
    const baseY = Y(0.7);
    const base = g.createRadialGradient(baseX, baseY, 0, baseX, baseY, R * 0.09);
    base.addColorStop(0, 'rgba(230, 244, 255, 0.95)');
    base.addColorStop(1, 'transparent');
    g.globalAlpha = 0.8;
    g.fillStyle = base;
    g.beginPath();
    g.ellipse(baseX, baseY, R * 0.05, R * 0.09, 0, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 0.28;
    g.beginPath();
    g.ellipse(baseX, baseY + R * 0.16, R * 0.08, R * 0.03, 0, 0, Math.PI * 2);
    g.fill();

    // 一整片树冠
    traceCrown(g, X, Y, pulse);
    const crownX = X(0, -0.3);
    const crownY = Y(-0.3);
    const fill = g.createRadialGradient(crownX, crownY, R * 0.02, crownX, crownY, R * 0.62);
    fill.addColorStop(0, '#f7fbff');
    fill.addColorStop(0.35, '#dceaff');
    fill.addColorStop(0.7, '#c5d4ee');
    fill.addColorStop(1, '#a9bcdc');
    g.globalAlpha = 0.96;
    g.fillStyle = fill;
    g.fill();
    g.save();
    traceCrown(g, X, Y, pulse);
    g.clip();
    const blush = g.createRadialGradient(X(0.22, -0.22), Y(-0.22), R * 0.02, X(0.22, -0.22), Y(-0.22), R * 0.38);
    blush.addColorStop(0, 'rgba(246, 226, 234, 0.55)');
    blush.addColorStop(1, 'transparent');
    g.globalAlpha = 1;
    g.fillStyle = blush;
    g.fillRect(0, 0, w, h);
    const heart = g.createRadialGradient(crownX, crownY, 0, crownX, crownY, R * (0.22 + 0.04 * pulse));
    heart.addColorStop(0, tint ?? 'rgba(255, 255, 255, 0.95)');
    heart.addColorStop(0.45, 'rgba(190, 220, 255, 0.45)');
    heart.addColorStop(1, 'transparent');
    g.globalAlpha = 0.75 + 0.2 * pulse;
    g.fillStyle = heart;
    g.fillRect(0, 0, w, h);
    const leafColor = ['#f7fbff', '#e4eefc', '#f3e0ea', '#c5d6ef'];
    for (const leaf of CROWN_LEAVES) {
        g.save();
        g.translate(X(leaf.x, leaf.y), Y(leaf.y));
        g.rotate(leaf.rot);
        g.fillStyle = leafColor[Math.floor(leaf.tint * leafColor.length) % leafColor.length]!;
        g.globalAlpha = 0.35 + 0.4 * leaf.tint;
        g.beginPath();
        g.ellipse(0, 0, leaf.w * R, leaf.w * R * 0.45, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
    }
    g.restore();

    for (const mote of IDLE_MOTES) {
        const dx = reduced ? 0 : Math.sin(t * 0.28 + mote.phase) * 0.04;
        const dy = reduced ? 0 : Math.cos(t * 0.2 + mote.phase) * 0.03;
        g.fillStyle = '#f4fbff';
        g.globalAlpha = 0.75;
        g.beginPath();
        g.arc(X(mote.x + dx, mote.y + dy), Y(mote.y + dy), Math.max(1.1, R * 0.008), 0, Math.PI * 2);
        g.fill();
    }
    g.globalAlpha = 1;
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
    /** 树冠和树干光的强弱。待机稳定,说话时略抬高。 */
    let pulse = 0.45;

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
        if (!knowledge) {
            if (!reduced) {
                const target = state === 'speaking' ? 0.45 + 0.4 * Math.min(1, smooth) : 0.45;
                const k = frameDt <= 0 ? 1 : 1 - Math.exp(-frameDt / 280);
                pulse += (target - pulse) * k;
            }
            paintRealTree(
                g,
                w,
                h,
                cx,
                cy,
                R,
                X,
                Y,
                pulse,
                tint.amount > 0.08 ? rgbString(tint.color) : null,
                reduced,
                t,
            );
        }

        // 知识模式仍画原来的枝干。助手模式用上面的整棵树。
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

        // 说话时叶片变成带光晕的光点,从树冠往下落。减少动态时 stepLeaves 已清空。
        if (!knowledge) {
            for (const leaf of leaves.leaves) {
                if (!leaf.active) continue;
                const alpha = leafAlpha(leaf.y);
                if (alpha <= 0) continue;
                const px = cx + leaf.x * R;
                const py = cy + leaf.y * R;
                const haloR = (5 + leaf.size * 4) * Math.max(0.65, scale);
                const halo = g.createRadialGradient(px, py, 0, px, py, haloR);
                halo.addColorStop(0, 'rgba(244, 251, 255, 0.95)');
                halo.addColorStop(1, 'transparent');
                g.fillStyle = halo;
                g.globalAlpha = alpha * 0.8;
                g.beginPath();
                g.arc(px, py, haloR, 0, Math.PI * 2);
                g.fill();
                g.fillStyle = '#ffffff';
                g.globalAlpha = alpha;
                g.beginPath();
                g.arc(px, py, Math.max(1.1, 1.5 * scale), 0, Math.PI * 2);
                g.fill();
            }
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
