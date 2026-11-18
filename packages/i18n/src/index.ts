// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { en } from './locales/en.js';
import { zh } from './locales/zh-CN.js';
import { formatMessage, type Vars } from './format.js';
import { DEFAULT_LOCALE, type Locale } from './locale.js';
import type { Key } from './locales/keys.js';

export type { Key } from './locales/keys.js';
export * from './locale.js';
export * from './dates.js';
export * from './prompts.js';
export { checkDictionaries } from './check.js';
export { compileMessage, formatMessage, messageArgs, type Vars } from './format.js';

export const dictionaries: Record<Locale, Record<Key, string>> = { 'zh-CN': zh, en };

export type Translate = (key: Key, vars?: Vars) => string;

/** 取字典里的文案并格式化;语言缺键时回落到 en(类型保证首发语言不缺键)。 */
export function translator(locale: Locale): Translate {
    const dict: Partial<Record<Key, string>> = dictionaries[locale];
    return (key, vars) => formatMessage(dict[key] ?? dictionaries[DEFAULT_LOCALE][key], vars, locale);
}
