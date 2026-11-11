// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音状态指示器(开发计划第 4.1 节、ADR 0021、M4 方案问题 3):Canvas 2D 画的粒子球。
// 不依赖任何库;按状态换颜色,随电平脉动(没有电平时缓慢呼吸),prefers-reduced-motion 时只画静态圆,
// 页面不可见时暂停动画。Canvas 不可用时 createVoiceOrb 返回 null,由调用方只显示文字。

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'executing';

/** 五种状态的颜色;浅色与深色主题共用,与背景的对比度都 ≥ 3:1。 */
export const ORB_COLORS: Readonly<Record<OrbState, string>> = {
    idle: '#7a8699',
    listening: '#16a34a',
    thinking: '#7c3aed',
    speaking: '#2563eb',
    executing: '#d97706',
};

export type Point3 = readonly [number, number, number];

/** 单位球面上大致均匀的 n 个点(斐波那契网格)。 */
export function fibonacciSphere(n: number): Point3[] {
    const points: Point3[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
        const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const theta = golden * i;
        points.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
    }
    return points;
}

/**
 * 球的缩放:有电平时 1 + 0.3 × level(电平先限制到 0–1);没有电平时按状态缓慢呼吸;
 * reducedMotion 时恒为 1。t 为毫秒。
 */
export function orbScale(t: number, level: number | null, state: OrbState, reducedMotion: boolean): number {
    if (reducedMotion) return 1;
    if (level !== null) return 1 + 0.3 * Math.min(1, Math.max(0, level));
    const period = state === 'idle' ? 4000 : state === 'thinking' || state === 'executing' ? 1200 : 2000;
    const depth = state === 'idle' ? 0.03 : 0.08;
    return 1 + depth * Math.sin((2 * Math.PI * t) / period);
}

/** 每秒的自转角度(弧度);thinking / executing 转得快一些。 */
export function spinRate(state: OrbState): number {
    return state === 'thinking' || state === 'executing' ? 1.2 : state === 'idle' ? 0.2 : 0.5;
}

export interface VoiceOrbOptions {
    /** 不给时读取 prefers-reduced-motion。 */
    reducedMotion?: boolean;
    /** 粒子数,默认 140。 */
    particles?: number;
}

export interface VoiceOrb {
    setState(state: OrbState): void;
    /** 本地录音 / 播放的电平(0–1);null 表示没有电平,用呼吸动画。 */
    setLevel(level: number | null): void;
    destroy(): void;
}

function prefersReducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function createVoiceOrb(canvas: HTMLCanvasElement, options: VoiceOrbOptions = {}): VoiceOrb | null {
    let ctx: CanvasRenderingContext2D | null;
    try {
        ctx = canvas.getContext('2d');
    } catch {
        ctx = null;
    }
    if (!ctx) return null;
    const context = ctx;
    const reducedMotion = options.reducedMotion ?? prefersReducedMotion();
    const points = fibonacciSphere(options.particles ?? 140);
    let state: OrbState = 'idle';
    let level: number | null = null;
    let angle = 0;
    let last = performance.now();
    let frame: number | null = null;
    let destroyed = false;

    const draw = (now: number) => {
        const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
        const w = canvas.clientWidth || canvas.width;
        const h = canvas.clientHeight || canvas.height;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, w, h);
        const color = ORB_COLORS[state];
        const cx = w / 2;
        const cy = h / 2;
        const radius = (Math.min(w, h) / 2) * 0.72 * orbScale(now, level, state, reducedMotion);
        if (reducedMotion) {
            // 静态指示:实心圆 + 外圈,不随时间变化
            context.fillStyle = color;
            context.globalAlpha = 0.85;
            context.beginPath();
            context.arc(cx, cy, radius * 0.8, 0, Math.PI * 2);
            context.fill();
            context.globalAlpha = 1;
            context.strokeStyle = color;
            context.lineWidth = 2;
            context.beginPath();
            context.arc(cx, cy, radius, 0, Math.PI * 2);
            context.stroke();
            return;
        }
        angle += ((now - last) / 1000) * spinRate(state);
        last = now;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        context.fillStyle = color;
        for (const [x, y, z] of points) {
            const rx = x * cos + z * sin;
            const rz = -x * sin + z * cos;
            const depth = (rz + 1) / 2; // 0(远)– 1(近)
            context.globalAlpha = 0.25 + 0.75 * depth;
            context.beginPath();
            context.arc(cx + rx * radius, cy + y * radius, 0.8 + 1.6 * depth, 0, Math.PI * 2);
            context.fill();
        }
        context.globalAlpha = 1;
    };

    const loop = (now: number) => {
        frame = null;
        if (destroyed) return;
        draw(now);
        schedule();
    };
    const schedule = () => {
        if (destroyed || reducedMotion || frame !== null) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        frame = requestAnimationFrame(loop);
    };
    const onVisibility = () => {
        if (document.hidden) {
            if (frame !== null) cancelAnimationFrame(frame);
            frame = null;
        } else {
            last = performance.now();
            schedule();
        }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

    draw(performance.now());
    schedule();

    return {
        setState(next) {
            state = next;
            if (reducedMotion) draw(performance.now());
        },
        setLevel(next) {
            level = next;
        },
        destroy() {
            destroyed = true;
            if (frame !== null) cancelAnimationFrame(frame);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        },
    };
}
