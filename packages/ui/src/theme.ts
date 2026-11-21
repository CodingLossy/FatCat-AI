// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 主题引擎(M12,ADR 0046):主题 = 一组 CSS token(tokens.css 里的 [data-theme])+ 一个主视觉实现。
// 主视觉同时是语音球和知识地图,所有主题实现同一个接口,界面只面对接口,不认具体主题。

import { createCatHero } from './heroes/cat.js';
import { createNatureHero } from './heroes/nature.js';
import { createTechHero } from './heroes/tech.js';
import type { KnowledgeScene } from './knowledge-model.js';
import type { OrbState } from './orb-model.js';
import { resolveTheme, type ThemeId } from './theme-ids.js';

export { DEFAULT_THEME, resolveTheme, THEME_IDS, THEMES, type ThemeId } from './theme-ids.js';

/** 主视觉的两种用途:助手(待机 / 聆听 / 思考 / 说话)和知识地图。 */
export type HeroMode = 'assistant' | 'knowledge';

export interface Hero {
    setState(state: OrbState): void;
    /** 本地录音 / 播放的电平(0–1);null 表示没有电平。说话时主视觉随它起伏。 */
    setLevel(level: number | null): void;
    setMode(mode: HeroMode): void;
    /** 知识模式画的内容:第一层、展开路径、子项、选中、命中路径。null 表示不画节点。 */
    setScene(scene: KnowledgeScene | null): void;
    /** 画布坐标(CSS 像素)处的节点 id;没有时为 null。 */
    pick(x: number, y: number): string | null;
    /** 节点当前在画布上的位置(CSS 像素),用来摆放气泡;不在画面上时为 null。 */
    locate(id: string): { x: number; y: number } | null;
    destroy(): void;
}

export interface HeroOptions {
    /** 不给时读取 prefers-reduced-motion;减少动态时每次变化只画一帧静态图。 */
    reducedMotion?: boolean;
}

export type HeroFactory = (canvas: HTMLCanvasElement, options: HeroOptions) => Hero | null;

const FACTORIES: Partial<Record<ThemeId, HeroFactory>> = {
    tech: createTechHero,
    nature: createNatureHero,
    cat: createCatHero,
};

/** Canvas 不可用时返回 null,调用方只显示文字。主题没有自己的实现时用科技的。 */
export function createHero(theme: unknown, canvas: HTMLCanvasElement, options: HeroOptions = {}): Hero | null {
    const factory = FACTORIES[resolveTheme(theme)] ?? createTechHero;
    return factory(canvas, options);
}
