// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 核心球的纯逻辑(docs/design/ui-redesign.md 第 4 节):状态预设、自适应质量、粒子生成与投影、声波条高度。
// 没有 DOM 依赖,canvas 适配层在 voice-orb.ts。

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'executing';
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

export const MAX_PARTICLES = 2600;
export const MIN_QUALITY = 0.35;

export interface OrbPreset {
    /** 粒子数占 MAX_PARTICLES 的比例。 */
    density: number;
    /** 自转速度(弧度 / 秒)。 */
    spin: number;
    /** 粒子抖动幅度(单位球半径的比例)。 */
    jitter: number;
    /** 呼吸幅度。 */
    pulse: number;
    /** 是否有一条冰青粒子带从极到极扫过。 */
    band: boolean;
    /** 粒子是否随输出电平向外抬起。 */
    lift: boolean;
    /** 声波条振幅(0–1)。 */
    wave: number;
}

/** 状态之间只改密度和运动,颜色不变。idle 与 listening 同,executing 与 thinking 同。 */
const PRESETS: Readonly<Record<'listening' | 'thinking' | 'speaking', OrbPreset>> = {
    listening: { density: 0.5, spin: 0.12, jitter: 0.004, pulse: 0.012, band: false, lift: false, wave: 0.1 },
    thinking: { density: 1, spin: 0.5, jitter: 0.014, pulse: 0.004, band: true, lift: false, wave: 0.18 },
    speaking: { density: 0.78, spin: 0.2, jitter: 0.006, pulse: 0.05, band: false, lift: true, wave: 1 },
};

export function presetFor(state: OrbState): OrbPreset {
    if (state === 'thinking' || state === 'executing') return PRESETS.thinking;
    if (state === 'speaking') return PRESETS.speaking;
    return PRESETS.listening;
}

/** 本轮实际画多少粒子:密度 × 质量,向下取整。 */
export function particleCount(preset: OrbPreset, quality: number): number {
    return Math.max(0, Math.floor(MAX_PARTICLES * preset.density * Math.min(1, Math.max(MIN_QUALITY, quality))));
}

/** 低端设备(核心数或内存 ≤ 4)和手机(屏幕短边 < 600px)从 60% 起步。 */
export function initialQuality(hardwareConcurrency?: number, deviceMemory?: number, screenShortSide?: number): number {
    const low =
        (hardwareConcurrency !== undefined && hardwareConcurrency <= 4) ||
        (deviceMemory !== undefined && deviceMemory <= 4) ||
        (screenShortSide !== undefined && screenShortSide > 0 && screenShortSide < 600);
    return low ? 0.6 : 1;
}

/**
 * 手机(屏幕短边 < 600,与 initialQuality 同一条线)或很小的画布。
 * 说话时的落叶用它把数量压低;星点本身仍走画质预算。
 */
export function compactDisplay(canvasMin: number, screenShort?: number): boolean {
    if (screenShort !== undefined && screenShort > 0 && screenShort < 600) return true;
    return canvasMin > 0 && canvasMin < 360;
}

export interface QualityState {
    quality: number;
    /** 慢帧计数:慢帧 +1,正常帧 −1(不小于 0)。 */
    slow: number;
}

export const SLOW_FRAME_MS = 24;
export const SLOW_FRAMES_TO_DROP = 45;
/** 超过这个间隔多半是标签页刚恢复或被挂起,不算慢帧。 */
const IGNORE_GAP_MS = 250;

/** 自适应质量:连续约 45 帧慢帧后粒子数下调 20%,下限 35%,本会话内不再回升。 */
export function stepQuality(s: QualityState, dtMs: number): QualityState {
    if (dtMs > IGNORE_GAP_MS || dtMs <= 0) return s;
    let slow = dtMs > SLOW_FRAME_MS ? s.slow + 1 : Math.max(0, s.slow - 1);
    let quality = s.quality;
    if (slow > SLOW_FRAMES_TO_DROP && quality > MIN_QUALITY) {
        quality = Math.max(MIN_QUALITY, quality * 0.8);
        slow = 0;
    }
    return { quality, slow };
}

export interface OrbParticle {
    x: number;
    y: number;
    z: number;
    /** 大小因子 0–1。 */
    s: number;
    /** 亮度因子 0–1。 */
    b: number;
    /** 约 16% 的粒子带冰青色。 */
    ice: boolean;
    /** 抖动相位。 */
    phase: number;
}

function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 确定性地生成 n 个粒子(同一个种子同一个结果)。点按种子洗牌,所以按比例取前缀(降低密度)仍然覆盖整个球面。 */
export function generateParticles(n: number, seed = 7): OrbParticle[] {
    const rnd = mulberry32(seed);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const out: OrbParticle[] = [];
    for (let i = 0; i < n; i++) {
        const y = 1 - (2 * (i + 0.5)) / n;
        const r = Math.sqrt(1 - y * y);
        const th = golden * i;
        out.push({
            x: Math.cos(th) * r,
            y,
            z: Math.sin(th) * r,
            s: rnd(),
            b: rnd(),
            ice: rnd() < 0.16,
            phase: rnd() * Math.PI * 2,
        });
    }
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const a = out[i] as OrbParticle;
        out[i] = out[j] as OrbParticle;
        out[j] = a;
    }
    return out;
}

export interface Projection {
    cx: number;
    cy: number;
    radius: number;
    /** 绕竖轴的自转角。 */
    rotation: number;
    /** 绕横轴的倾角。 */
    tilt: number;
}

/** 单位球内的点投影到画布:先自转再倾斜,近大远小。返回 [x, y, 深度];深度 −1(远)到 1(近)。 */
export function projectPoint(x: number, y: number, z: number, p: Projection): Point3 {
    const cr = Math.cos(p.rotation);
    const sr = Math.sin(p.rotation);
    const x1 = x * cr + z * sr;
    const z1 = -x * sr + z * cr;
    const ct = Math.cos(p.tilt);
    const st = Math.sin(p.tilt);
    const y1 = y * ct - z1 * st;
    const z2 = y * st + z1 * ct;
    const scale = p.radius * (1 + 0.16 * z2);
    return [p.cx + x1 * scale, p.cy + y1 * scale, z2];
}

/** 合成的说话包络(没有 TTS 电平时用),0–1。t 为秒。 */
export function syntheticEnvelope(t: number): number {
    return 0.5 + 0.5 * Math.sin(t * 6.1) * Math.sin(t * 2.3 + 1);
}

/** 有电平时用电平(限制到 0–1),否则说话状态用合成包络,其余状态为 0。 */
export function orbEnergy(state: OrbState, level: number | null, t: number): number {
    if (level !== null) return Math.min(1, Math.max(0, level));
    return state === 'speaking' ? syntheticEnvelope(t) : 0;
}

/** 声波条的高度(像素),两端低中间高;reducedMotion 时全部为最低高度(3px)。 */
export function waveHeights(
    count: number,
    state: OrbState,
    energy: number,
    t: number,
    maxPx: number,
    reducedMotion = false,
): number[] {
    if (reducedMotion) return new Array<number>(count).fill(3);
    const amp = presetFor(state).wave;
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
        const env = count > 1 ? Math.sin((Math.PI * i) / (count - 1)) : 1;
        const v = Math.abs(Math.sin(i * 0.9 + t * 7) * 0.6 + Math.sin(i * 0.37 - t * 4) * 0.4);
        const drive = state === 'speaking' ? 0.35 + 0.65 * energy : 1;
        out.push(Math.max(3, 4 + amp * drive * env * v * (maxPx - 4)));
    }
    return out;
}
