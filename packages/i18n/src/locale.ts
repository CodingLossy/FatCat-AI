// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语言清单与解析。新增语言:在这里加一项,再加 locales/<code>.ts(见 docs/contributing/translations.md)。

export const LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
/** 各语言的自称(不翻译,界面语言选择器直接显示)。 */
export const LOCALE_NAMES: Record<Locale, string> = { 'zh-CN': '中文', en: 'English' };

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
    return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** 设置里的语言优先;否则按浏览器语言列表匹配(zh、zh-TW 等归到 zh-CN);都不匹配用 en。 */
export function resolveLocale(setting: string | null | undefined, preferred: readonly string[] = []): Locale {
    if (isLocale(setting)) return setting;
    for (const p of preferred) {
        if (isLocale(p)) return p;
        const base = p.toLowerCase().split('-')[0];
        if (base === 'zh') return 'zh-CN';
        if (base === 'en') return 'en';
    }
    return DEFAULT_LOCALE;
}
