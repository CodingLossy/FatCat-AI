// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 主题标识与设置值解析(纯数据,不含 canvas);界面静态引用它,主视觉的代码按需加载。

export const THEME_IDS = ['tech', 'nature', 'cat'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = 'tech';

/** 已经有 token 和主视觉的主题。自然、猫咪各自的 PR 合并时把 ready 改成 true。 */
export const THEMES: readonly { readonly id: ThemeId; readonly ready: boolean }[] = [
    { id: 'tech', ready: true },
    { id: 'nature', ready: true },
    { id: 'cat', ready: false },
];

/**
 * 把存下来的设置值变成要用的主题:旧值(system / light / dark / obsidian / nebula 等)、未知值和还没做好的主题
 * 一律按科技处理。只读,不改写已存的设置。
 */
export function resolveTheme(value: unknown): ThemeId {
    const found = THEMES.find((t) => t.id === value);
    return found?.ready ? found.id : DEFAULT_THEME;
}
