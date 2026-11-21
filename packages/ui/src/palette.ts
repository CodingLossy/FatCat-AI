// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// Canvas 绘制读取主题颜色:颜色只写在 tokens.css 里,canvas 代码用 token 名(--xxx)取当前主题的值。

/** 读一个 CSS 自定义属性;拿不到(无 DOM、未定义)时用 fallback。 */
export function cssToken(el: Element | null, name: string, fallback: string): string {
    if (!el || typeof getComputedStyle !== 'function') return fallback;
    return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** 颜色值可以是 token 名(以 -- 开头)或普通颜色;token 名按元素当前主题解析。 */
export function resolveColor(el: Element | null, color: string, fallback = 'currentColor'): string {
    return color.startsWith('--') ? cssToken(el, color, fallback) : color;
}
