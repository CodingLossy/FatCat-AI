// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 核心球的 canvas 适配层(ui-redesign.md 第 4 节、ADR 0021、ADR 0046):Canvas 2D 画银白线框粒子球和声波条。
// 数值与逻辑在 orb-model.ts。所有球共用一个 requestAnimationFrame 循环,页面不可见时暂停;
// prefers-reduced-motion 时每次状态变化只画一帧静态图;Canvas 不可用时 createVoiceOrb 返回 null,调用方只显示文字。

import {
    generateParticles,
    initialQuality,
    MAX_PARTICLES,
    orbEnergy,
    type OrbParticle,
    type OrbState,
    particleCount,
    presetFor,
    projectPoint,
    type Projection,
    type QualityState,
    stepQuality,
    waveHeights,
} from './orb-model.js';

export {
    compactDisplay,
    fibonacciSphere,
    generateParticles,
    initialQuality,
    MAX_PARTICLES,
    MIN_QUALITY,
    orbEnergy,
    type OrbParticle,
    type OrbPreset,
    type OrbState,
    particleCount,
    type Point3,
    presetFor,
    projectPoint,
    type Projection,
    type QualityState,
    stepQuality,
    waveHeights,
} from './orb-model.js';

export interface VoiceOrbOptions {
    /** 不给时读取 prefers-reduced-motion。 */
    reducedMotion?: boolean;
    /** 球下方的声波条 canvas(可选)。 */
    waveCanvas?: HTMLCanvasElement | null;
}

export interface VoiceOrb {
    setState(state: OrbState): void;
    /** 本地录音 / 播放的电平(0–1);null 表示没有电平。 */
    setLevel(level: number | null): void;
    destroy(): void;
}

export function prefersReducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------- 共用的帧循环与质量 ----------

type Tick = (nowMs: number) => void;
const ticks = new Set<Tick>();
let frame: number | null = null;
let lastTs = 0;
let qualityState: QualityState | null = null;

export function currentQuality(): QualityState {
    if (!qualityState) {
        const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number });
        const scr = typeof screen === 'undefined' ? undefined : Math.min(screen.width, screen.height);
        qualityState = { quality: initialQuality(nav?.hardwareConcurrency, nav?.deviceMemory, scr), slow: 0 };
    }
    return qualityState;
}

/** 窗口没有焦点(在后台但仍可见)时降到约 15 帧;完全隐藏时整个循环暂停(见下方 visibilitychange)。 */
export const BACKGROUND_FRAME_MS = 66;

function unfocused(): boolean {
    return typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus();
}

function loop(now: number): void {
    frame = null;
    if (ticks.size === 0) return;
    if (lastTs && unfocused() && now - lastTs < BACKGROUND_FRAME_MS) {
        schedule();
        return;
    }
    // 降帧时的长间隔不算作卡顿,不拿去降低粒子数
    if (lastTs && !unfocused()) qualityState = stepQuality(currentQuality(), now - lastTs);
    lastTs = now;
    for (const tick of [...ticks]) tick(now);
    schedule();
}

function schedule(): void {
    if (frame !== null || ticks.size === 0) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    frame = requestAnimationFrame(loop);
}

export function addTick(tick: Tick): () => void {
    ticks.add(tick);
    schedule();
    return () => {
        ticks.delete(tick);
        if (ticks.size === 0 && frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
            lastTs = 0;
        }
    };
}

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (frame !== null) cancelAnimationFrame(frame);
            frame = null;
        } else {
            lastTs = 0; // 恢复后第一帧的间隔不计入质量
            schedule();
        }
    });
}

let particleCache: OrbParticle[] | null = null;
function particles(): OrbParticle[] {
    return (particleCache ??= generateParticles(MAX_PARTICLES));
}

// ---------- 绘制 ----------

interface Palette {
    fg: string;
    accent: string;
}

function readPalette(el: HTMLElement): Palette {
    try {
        const cs = getComputedStyle(el);
        return {
            fg: cs.getPropertyValue('--fg').trim() || '#e2e8ff',
            accent: cs.getPropertyValue('--accent').trim() || '#38bdf8',
        };
    } catch {
        return { fg: '#e2e8ff', accent: '#38bdf8' };
    }
}

export function fitCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
}

const TILT = 0.3;
const ALPHA_BUCKETS = 6;

function drawSphere(
    canvas: HTMLCanvasElement,
    palette: Palette,
    state: OrbState,
    energy: number,
    tSec: number,
    reduced: boolean,
): void {
    const fit = fitCanvas(canvas);
    if (!fit) return;
    const { ctx: g, w, h } = fit;
    const preset = presetFor(state);
    const R = Math.min(w, h) * 0.47;
    const proj: Projection = {
        cx: w / 2,
        cy: h / 2,
        radius: R * (1 + preset.pulse * (reduced ? 0 : preset.lift ? energy : Math.sin(tSec * 2.2))),
        rotation: tSec * preset.spin + 0.6,
        tilt: TILT,
    };

    // 线框:纬圈与经线,0.5px、10% 透明度
    g.lineWidth = 0.5;
    g.strokeStyle = palette.fg;
    g.globalAlpha = 0.16;
    g.beginPath();
    g.arc(proj.cx, proj.cy, R * 1.02, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 0.1;
    const ring = (point: (a: number) => [number, number, number]) => {
        g.beginPath();
        for (let i = 0; i <= 64; i++) {
            const [x, y, z] = point((i / 64) * Math.PI * 2);
            const q = projectPoint(x, y, z, proj);
            if (i) g.lineTo(q[0], q[1]);
            else g.moveTo(q[0], q[1]);
        }
        g.stroke();
    };
    for (let lat = -60; lat <= 60; lat += 30) {
        const ly = Math.sin((lat * Math.PI) / 180);
        const lr = Math.cos((lat * Math.PI) / 180);
        ring((a) => [Math.cos(a) * lr, ly, Math.sin(a) * lr]);
    }
    for (let lon = 0; lon < 180; lon += 30) {
        const b = (lon * Math.PI) / 180;
        ring((a) => [Math.cos(a) * Math.cos(b), Math.sin(a), Math.cos(a) * Math.sin(b)]);
    }

    // 粒子:按(颜色 × 透明度档)合并成路径,减少 fill 次数
    const n = particleCount(preset, currentQuality().quality);
    const all = particles();
    const buckets: Path2D[] = [];
    for (let i = 0; i < ALPHA_BUCKETS * 2; i++) buckets.push(new Path2D());
    const bandY = Math.sin(tSec * 0.9) * 0.8;
    for (let i = 0; i < n; i++) {
        const p = all[i];
        if (!p) break;
        const jx = reduced ? 0 : Math.sin(tSec * 1.7 + p.phase) * preset.jitter;
        const jy = reduced ? 0 : Math.cos(tSec * 1.3 + p.phase * 2) * preset.jitter;
        const lift = preset.lift && !reduced ? 1 + 0.035 * energy * Math.sin(p.phase * 3 + tSec * 5) : 1;
        const q = projectPoint((p.x + jx) * lift, (p.y + jy) * lift, p.z * lift, proj);
        const depth = (q[2] + 1) / 2;
        const ice = p.ice || (preset.band && Math.abs(p.y - bandY) < 0.06);
        const alpha = Math.min(1, (0.2 + 0.8 * depth) * (0.6 + 0.6 * p.b));
        const bucket = Math.min(ALPHA_BUCKETS - 1, Math.floor(alpha * ALPHA_BUCKETS));
        const size = (0.4 + p.s * p.s * 1.6) * (0.5 + 0.9 * depth);
        const path = buckets[(ice ? ALPHA_BUCKETS : 0) + bucket];
        path?.moveTo(q[0] + size, q[1]);
        path?.arc(q[0], q[1], size, 0, Math.PI * 2);
    }
    for (let i = 0; i < buckets.length; i++) {
        g.fillStyle = i >= ALPHA_BUCKETS ? palette.accent : palette.fg;
        g.globalAlpha = ((i % ALPHA_BUCKETS) + 0.5) / ALPHA_BUCKETS;
        g.fill(buckets[i] as Path2D);
    }
    g.globalAlpha = 1;
}

const WAVE_BARS = 56;

function drawWave(
    canvas: HTMLCanvasElement,
    palette: Palette,
    state: OrbState,
    energy: number,
    tSec: number,
    reduced: boolean,
): void {
    const fit = fitCanvas(canvas);
    if (!fit) return;
    const { ctx: g, w, h } = fit;
    const heights = waveHeights(WAVE_BARS, state, energy, tSec, h, reduced);
    const step = w / WAVE_BARS;
    g.fillStyle = palette.accent;
    for (let i = 0; i < WAVE_BARS; i++) {
        const bh = Math.min(h, heights[i] ?? 3);
        g.globalAlpha = 0.85;
        g.fillRect(i * step + step * 0.25, (h - bh) / 2, step * 0.5, bh);
    }
    g.globalAlpha = 1;
}

export function createVoiceOrb(canvas: HTMLCanvasElement, options: VoiceOrbOptions = {}): VoiceOrb | null {
    let probe: CanvasRenderingContext2D | null;
    try {
        probe = canvas.getContext('2d');
    } catch {
        probe = null;
    }
    if (!probe) return null;
    const reduced = options.reducedMotion ?? prefersReducedMotion();
    let state: OrbState = 'idle';
    let level: number | null = null;
    let palette = readPalette(canvas);
    let destroyed = false;
    const start = performance.now();

    let frames = 0;
    const render = (nowMs: number) => {
        if (!reduced && ++frames % 120 === 0) palette = readPalette(canvas); // 同一状态下切换主题也会跟上
        const t = reduced ? 4.2 : (nowMs - start) / 1000; // 静态图固定相位,截图可复现
        const energy = reduced ? 0 : orbEnergy(state, level, t);
        drawSphere(canvas, palette, state, energy, t, reduced);
        if (options.waveCanvas) drawWave(options.waveCanvas, palette, state, energy, t, reduced);
    };

    render(performance.now());
    const remove = reduced ? () => undefined : addTick(render);
    // 系统明暗切换:刷新颜色(减少动效时没有帧循环,所以同时重画一帧)
    const scheme = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    const onScheme = () => {
        palette = readPalette(canvas);
        if (reduced) render(performance.now());
    };
    scheme?.addEventListener?.('change', onScheme);

    // 应用内切换主题改的是根元素的 data-theme / class,不是 prefers-color-scheme。
    // 减少动效时没有帧循环,所以这里重读颜色并重画一帧。
    const root = canvas.ownerDocument?.documentElement ?? null;
    let themeObserver: MutationObserver | null = null;
    if (root && typeof MutationObserver === 'function') {
        themeObserver = new MutationObserver(() => {
            palette = readPalette(canvas);
            if (reduced) render(performance.now());
        });
        themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    }

    return {
        setState(next) {
            if (destroyed) return;
            state = next;
            palette = readPalette(canvas); // 主题切换后下一次状态变化时刷新
            if (reduced) render(performance.now());
        },
        setLevel(next) {
            level = next;
        },
        destroy() {
            destroyed = true;
            remove();
            scheme?.removeEventListener?.('change', onScheme);
            themeObserver?.disconnect();
        },
    };
}
