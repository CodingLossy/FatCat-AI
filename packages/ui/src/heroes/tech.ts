// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 科技主视觉:纯黑底上一颗几千星点的球(白、淡紫、青),内部淡青星云雾,边缘几簇星座连线。
// 颜色来自 tokens.css 的 --hero-* 变量;所有主视觉共用 voice-orb.ts 里的帧循环(页面不可见时暂停)。

import { expandedId, type KnowledgeScene, pickNode, type ScreenNode } from '../knowledge-model.js';
import { MAX_PARTICLES, orbEnergy, type OrbState, projectPoint, type Projection } from '../orb-model.js';
import type { Hero, HeroMode, HeroOptions } from '../theme.js';
import { addTick, currentQuality, fitCanvas, prefersReducedMotion } from '../voice-orb.js';
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
import { drawTechKnowledge, type KnowledgePalette } from './tech-knowledge.js';
import { starLift, TECH_STAR_COUNT, techConstellations, techLook, techStars } from './tech-model.js';

interface Palette {
    stars: [string, string, string];
    fog: string;
    line: string;
    states: StateColors;
    knowledge: KnowledgePalette;
}

/** 科技主题的状态色(tokens.css 缺失时的后备):聆听淡蓝白、检测到语音亮绿、思考紫、说话深亮蓝。 */
const TECH_STATES: StateColors = {
    listening: [214, 236, 255],
    heard: [61, 245, 138],
    thinking: [180, 140, 255],
    speaking: [61, 139, 255],
};

function readPalette(el: HTMLElement): Palette {
    const cs = getComputedStyle(el);
    const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
        stars: [get('--hero-star-a', '#fff'), get('--hero-star-b', '#b9a8ff'), get('--hero-star-c', '#5fe3c8')],
        fog: get('--hero-fog', '#5fe3c8'),
        line: get('--hero-line', '#e2e8ff'),
        states: readStateColors((name) => cs.getPropertyValue(name), 'hero', TECH_STATES),
        knowledge: {
            star: get('--hero-star-a', '#fff'),
            hit: get('--hero-star-c', '#5fe3c8'),
            accent: get('--accent', '#38bdf8'),
            danger: get('--danger', '#e5857f'),
            line: get('--hero-line', '#e2e8ff'),
            label: get('--fg', '#e2e8ff'),
            font: get('--font-sans', 'system-ui, sans-serif'),
        },
    };
}

const STARS = techStars(TECH_STAR_COUNT);
const CONSTELLATIONS = techConstellations();
const BUCKETS = 5;

export function createTechHero(canvas: HTMLCanvasElement, options: HeroOptions): Hero | null {
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
    let tint: Tint = { color: TECH_STATES.listening, amount: 0 };
    let spin = 0.04;
    let wobble = 0;
    let mode: HeroMode = 'assistant';
    let level: number | null = null;
    let palette = readPalette(canvas);
    let destroyed = false;
    let angle = 0;
    let lastMs = 0;
    let frames = 0;
    const start = performance.now();
    let scene: KnowledgeScene | null = null;
    let screen: ScreenNode[] = [];
    let explodeAt = 0;
    let explodeFrom: { x: number; y: number } | null = null;
    // 知识层的漂移时间:有选中的节点(气泡打开)时停住,气泡不跟着跑
    let layoutT = 0;
    let lastLayoutMs = 0;

    const draw = (nowMs: number) => {
        if (!reduced && ++frames % 120 === 0) palette = readPalette(canvas);
        const t = reduced ? 4.2 : (nowMs - start) / 1000;
        const look = techLook(state, mode === 'knowledge');
        const lv = level ?? 0;
        const dt = lastMs ? Math.min(100, nowMs - lastMs) : 0;
        // 状态色平滑过渡;减少动态时直接换色(每次变化只画一帧)
        tint = stepTint(tint, heroState, palette.states, dt, reduced || !lastMs);
        // 转速与摆动也平滑过渡,换状态时不会突然反转
        const ease = 1 - Math.exp(-dt / 260);
        spin += (look.spin - spin) * ease;
        wobble += (look.wobble - wobble) * ease;
        if (!reduced && lastMs) angle += spin * (dt / 1000);
        lastMs = nowMs;
        const energy = reduced ? 0 : orbEnergy(state, level, t);
        const fit = fitCanvas(canvas);
        if (!fit) return;
        const { ctx: g, w, h } = fit;
        const R = Math.min(w, h) * 0.46;
        const proj: Projection = {
            cx: w / 2,
            cy: h / 2,
            radius: R * (1 + (reduced ? 0 : 0.03 * energy)),
            rotation: reduced ? 0.6 : angle + 0.6,
            tilt: reduced ? 0.3 : 0.3 + wobble * Math.sin(t * 0.9),
        };

        // 内部星云雾
        const fog = g.createRadialGradient(proj.cx, proj.cy, 0, proj.cx, proj.cy, proj.radius);
        // 星云雾也染上状态色,颜色从远处也看得出来
        const fogRgb = parseColor(palette.fog);
        fog.addColorStop(0, fogRgb ? rgbString(mixRgb(fogRgb, tint.color, tint.amount)) : palette.fog);
        fog.addColorStop(1, 'transparent');
        g.globalAlpha = (0.1 + 0.08 * tint.amount) * look.brightness;
        g.fillStyle = fog;
        g.beginPath();
        g.arc(proj.cx, proj.cy, proj.radius, 0, Math.PI * 2);
        g.fill();

        // 星点:按(颜色 × 透明度档)合并路径
        // 小画布(设置页预览)按半径减少星点并缩小点径,保持同样的疏密
        const scale = Math.min(1, R / 220);
        const n = Math.min(
            STARS.length,
            Math.round(MAX_PARTICLES * currentQuality().quality * 1.2 * Math.max(0.15, scale)),
        );
        // 前三组是星点自己的颜色,第四组是状态色
        const colors = [...palette.stars, rgbString(tint.color)];
        const paths: Path2D[] = [];
        for (let i = 0; i < colors.length * BUCKETS; i++) paths.push(new Path2D());
        for (let i = 0; i < n; i++) {
            const s = STARS[i];
            if (!s) break;
            const k = 1 + (reduced ? 0 : starLift(state, lv, s.phase, t));
            const q = projectPoint(s.x * k, s.y * k, s.z * k, proj);
            const depth = (q[2] + 1) / 2;
            const color = s.rank < tint.amount ? 3 : s.color;
            const alpha = (0.25 + 0.75 * depth) * (0.5 + 0.5 * s.size) * look.brightness;
            const bucket = Math.min(BUCKETS - 1, Math.floor(alpha * BUCKETS));
            const size = (0.45 + s.size * 1.4) * (0.55 + 0.8 * depth) * Math.max(0.5, scale);
            const path = paths[color * BUCKETS + bucket];
            path?.moveTo(q[0] + size, q[1]);
            path?.arc(q[0], q[1], size, 0, Math.PI * 2);
        }
        for (let i = 0; i < paths.length; i++) {
            g.fillStyle = colors[Math.floor(i / BUCKETS)] ?? palette.stars[0];
            g.globalAlpha = ((i % BUCKETS) + 0.6) / BUCKETS;
            g.fill(paths[i] as Path2D);
        }

        // 星座连线(只画朝向观察者一侧)
        g.strokeStyle = palette.line;
        g.fillStyle = palette.line;
        g.lineWidth = 1;
        for (const c of CONSTELLATIONS) {
            const pts = c.points.map((p) => projectPoint(p[0], p[1], p[2], proj));
            if (pts.every((p) => p[2] < -0.2)) continue;
            g.globalAlpha = 0.45 * look.lines;
            g.beginPath();
            pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
            g.stroke();
            g.globalAlpha = 0.9 * look.lines;
            for (const p of pts) {
                g.beginPath();
                g.arc(p[0], p[1], 1.6, 0, Math.PI * 2);
                g.fill();
            }
        }
        g.globalAlpha = 1;

        // 知识模式:在压暗的星球上画节点层
        if (mode === 'knowledge' && scene) {
            if (!reduced && lastLayoutMs && !scene.selectedId) layoutT += Math.min(0.1, (nowMs - lastLayoutMs) / 1000);
            lastLayoutMs = nowMs;
            screen = drawTechKnowledge(
                g,
                scene,
                {
                    cx: proj.cx,
                    cy: proj.cy,
                    radius: R,
                    tSec: layoutT,
                    explode: reduced ? 1 : (nowMs - explodeAt) / 650,
                    from: explodeFrom,
                },
                palette.knowledge,
            );
        } else screen = [];
        g.globalAlpha = 1;
    };

    draw(performance.now());
    const remove = reduced ? () => undefined : addTick(draw);
    // 应用内切主题改的是 <html data-theme>:重读颜色,减少动态时重画一帧
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
            if (after !== before) {
                // 新展开的节点从它现在的位置飞到中心
                explodeFrom = after ? (screen.find((n) => n.id === after) ?? null) : null;
                explodeAt = performance.now();
            }
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
