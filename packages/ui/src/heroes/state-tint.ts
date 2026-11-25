// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 主视觉的状态色(ADR 0049 第 10.4 节,纯函数,无 DOM):聆听、检测到语音、思考、说话各一种颜色,
// 每套主题自己定颜色(tokens.css),状态之间平滑过渡;减少动态时直接换色。

import type { OrbState } from '../orb-model.js';

/** 主视觉的状态:在助手状态之外多一个「检测到语音」(只在本机连续对话里出现,不上报)。 */
export type HeroState = OrbState | 'heard';

export type Rgb = readonly [number, number, number];

export interface StateColors {
    readonly listening: Rgb;
    readonly heard: Rgb;
    readonly thinking: Rgb;
    readonly speaking: Rgb;
}

/** 各状态染色的颜色与比例;待机不染色(比例 0,颜色沿用聆听,过渡时不会闪到别的颜色)。 */
export function tintTarget(state: HeroState): { key: keyof StateColors; amount: number } {
    switch (state) {
        case 'listening':
            return { key: 'listening', amount: 0.55 };
        case 'heard':
            return { key: 'heard', amount: 0.75 };
        case 'thinking':
        case 'executing':
            return { key: 'thinking', amount: 0.65 };
        case 'speaking':
            return { key: 'speaking', amount: 0.75 };
        default:
            return { key: 'listening', amount: 0 };
    }
}

/** 运动与形状仍按助手状态:「检测到语音」按聆听处理。 */
export function motionState(state: HeroState): OrbState {
    return state === 'heard' ? 'listening' : state;
}

/** 解析 tokens.css 里的颜色:#rgb、#rrggbb 或 rgb(r, g, b);其他写法返回 null。 */
export function parseColor(value: string): Rgb | null {
    const v = value.trim();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
    if (hex?.[1]) {
        const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(v);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((n) => Math.min(255, n)) as unknown as Rgb;
    return null;
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
    const k = Math.min(1, Math.max(0, t));
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function rgbString(c: Rgb): string {
    return `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
}

/** 过渡的时间常数(毫秒):约 3 倍这个时间基本到位。 */
export const TINT_EASE_MS = 140;

export interface Tint {
    readonly color: Rgb;
    readonly amount: number;
}

/**
 * 当前染色:每帧向目标靠近一步(指数缓动)。`instant` 为 true(减少动态、第一帧)时直接到目标。
 * 比例和颜色分开缓动:从待机进入某个状态时颜色直接取目标色,只有比例从 0 慢慢升上来。
 */
export function stepTint(current: Tint, state: HeroState, colors: StateColors, dtMs: number, instant: boolean): Tint {
    const target = tintTarget(state);
    const color = colors[target.key];
    if (instant) return { color, amount: target.amount };
    const k = 1 - Math.exp(-Math.max(0, dtMs) / TINT_EASE_MS);
    const from = current.amount < 0.02 ? color : current.color;
    return { color: mixRgb(from, color, k), amount: current.amount + (target.amount - current.amount) * k };
}

/** 从计算后的样式读出一套主题的状态色;变量缺失或写法不认识时用 fallback。 */
export function readStateColors(get: (name: string) => string, prefix: string, fallback: StateColors): StateColors {
    const read = (key: keyof StateColors) => parseColor(get(`--${prefix}-state-${key}`)) ?? fallback[key];
    return {
        listening: read('listening'),
        heard: read('heard'),
        thinking: read('thinking'),
        speaking: read('speaking'),
    };
}
