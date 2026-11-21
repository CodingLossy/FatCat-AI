// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 科技主视觉:纯黑底上一颗几千星点的球(白、淡紫、青),内部淡青星云雾,边缘几簇星座连线。
// 颜色来自 tokens.css 的 --hero-* 变量;所有主视觉共用 voice-orb.ts 里的帧循环(页面不可见时暂停)。

import { MAX_PARTICLES, orbEnergy, type OrbState, projectPoint, type Projection } from '../orb-model.js';
import type { Hero, HeroMode, HeroOptions } from '../theme.js';
import { addTick, currentQuality, fitCanvas, prefersReducedMotion } from '../voice-orb.js';
import { starLift, TECH_STAR_COUNT, techConstellations, techLook, techStars } from './tech-model.js';

interface Palette {
    stars: [string, string, string];
    fog: string;
    line: string;
}

function readPalette(el: HTMLElement): Palette {
    const cs = getComputedStyle(el);
    const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
        stars: [get('--hero-star-a', '#fff'), get('--hero-star-b', '#b9a8ff'), get('--hero-star-c', '#5fe3c8')],
        fog: get('--hero-fog', '#5fe3c8'),
        line: get('--hero-line', '#e2e8ff'),
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
    let mode: HeroMode = 'assistant';
    let level: number | null = null;
    let palette = readPalette(canvas);
    let destroyed = false;
    let angle = 0;
    let lastMs = 0;
    let frames = 0;
    const start = performance.now();

    const draw = (nowMs: number) => {
        if (!reduced && ++frames % 120 === 0) palette = readPalette(canvas);
        const t = reduced ? 4.2 : (nowMs - start) / 1000;
        const look = techLook(state, mode === 'knowledge');
        const lv = level ?? 0;
        if (!reduced && lastMs) angle += look.spin * Math.min(0.1, (nowMs - lastMs) / 1000);
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
            tilt: 0.3,
        };

        // 内部星云雾
        const fog = g.createRadialGradient(proj.cx, proj.cy, 0, proj.cx, proj.cy, proj.radius);
        fog.addColorStop(0, palette.fog);
        fog.addColorStop(1, 'transparent');
        g.globalAlpha = 0.1 * look.brightness;
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
        const paths: Path2D[] = [];
        for (let i = 0; i < 3 * BUCKETS; i++) paths.push(new Path2D());
        for (let i = 0; i < n; i++) {
            const s = STARS[i];
            if (!s) break;
            const k = 1 + (reduced ? 0 : starLift(state, lv, s.phase, t));
            const q = projectPoint(s.x * k, s.y * k, s.z * k, proj);
            const depth = (q[2] + 1) / 2;
            const color = s.rank < look.tintAmount ? look.tintColor : s.color;
            const alpha = (0.25 + 0.75 * depth) * (0.5 + 0.5 * s.size) * look.brightness;
            const bucket = Math.min(BUCKETS - 1, Math.floor(alpha * BUCKETS));
            const size = (0.45 + s.size * 1.4) * (0.55 + 0.8 * depth) * Math.max(0.5, scale);
            const path = paths[color * BUCKETS + bucket];
            path?.moveTo(q[0] + size, q[1]);
            path?.arc(q[0], q[1], size, 0, Math.PI * 2);
        }
        for (let i = 0; i < paths.length; i++) {
            g.fillStyle = palette.stars[Math.floor(i / BUCKETS)] ?? palette.stars[0];
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
        destroy() {
            destroyed = true;
            remove();
            observer?.disconnect();
        },
    };
}
