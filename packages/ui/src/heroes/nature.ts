// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 自然主视觉:雾夜森林里一棵由金色光点和细光线组成的树(枝干金色、树冠浅绿光点、根部微光),低处薄雾和萤火。
// 说话时整树随音量轻摇,思考时光沿树干往上爬。颜色来自 tokens.css 的 --nature-* 变量;帧循环与科技共用。

import { expandedId, type KnowledgeScene, pickNode, type ScreenNode } from '../knowledge-model.js';
import type { OrbState } from '../orb-model.js';
import type { Hero, HeroMode, HeroOptions } from '../theme.js';
import { addTick, currentQuality, fitCanvas, prefersReducedMotion } from '../voice-orb.js';
import { type AnchoredKnowledgePalette, drawAnchoredKnowledge } from './anchored-knowledge.js';
import {
    branchChain,
    climbGlow,
    natureFireflies,
    natureLook,
    natureTree,
    swayOffset,
    tipsFor,
    TREE_BASE,
} from './nature-model.js';

interface Palette {
    trunk: string;
    canopy: string;
    root: string;
    mist: string;
    firefly: string;
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
const FIREFLIES = natureFireflies();
const BUCKETS = 4;

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

    const draw = (nowMs: number) => {
        if (!reduced && ++frames % 120 === 0) palette = readPalette(canvas);
        const t = reduced ? 2.4 : (nowMs - start) / 1000;
        smooth += ((level ?? 0) - smooth) * 0.2;
        const knowledge = mode === 'knowledge';
        const look = natureLook(state, reduced ? 0 : smooth, knowledge);
        const fit = fitCanvas(canvas);
        if (!fit) return;
        const { ctx: g, w, h } = fit;
        const R = Math.min(w, h) * 0.46;
        const cx = w / 2;
        const cy = h / 2;
        const scale = Math.min(1, R / 220);
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
        const bx = X(TREE_BASE.x, TREE_BASE.y);
        const by = Y(TREE_BASE.y);
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
                const twinkle = color === 'canopy' ? 1 - look.shimmer * (0.5 + 0.5 * Math.sin(s.phase + t * 2.3)) : 1;
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
            g.fillStyle = color === 'trunk' ? palette.trunk : palette.canopy;
            paths.forEach((path, i) => {
                g.globalAlpha = (i + 0.7) / BUCKETS;
                g.fill(path);
            });
        };
        dotPaths('trunk');
        dotPaths('canopy');

        // 萤火:低处绕圈;聆听时向树冠聚拢
        if (!knowledge) {
            g.fillStyle = palette.firefly;
            for (const f of FIREFLIES) {
                const fx = f.x + Math.sin(t * f.speed * 0.6 + f.phase) * 0.08;
                const fy = f.y + Math.cos(t * f.speed * 0.5 + f.phase * 1.7) * 0.05;
                const gx = fx * (1 - 0.45 * look.gather);
                const gy = fy - (fy + 0.2) * 0.5 * look.gather;
                const blink = reduced ? 0.7 : 0.4 + 0.6 * Math.max(0, Math.sin(t * f.speed * 1.7 + f.phase));
                const px = cx + gx * R;
                const py = cy + gy * R;
                g.globalAlpha = 0.18 * blink;
                g.beginPath();
                g.arc(px, py, 5 * Math.max(0.5, scale), 0, Math.PI * 2);
                g.fill();
                g.globalAlpha = 0.85 * blink;
                g.beginPath();
                g.arc(px, py, 1.4 * Math.max(0.6, scale), 0, Math.PI * 2);
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
            state = next;
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
