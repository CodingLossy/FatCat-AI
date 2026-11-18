// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { LOCALES, DEFAULT_LOCALE, type Locale } from './locale.js';
import { messageArgs } from './format.js';

// 服务器 detail 是英文原文:中文提示可以不带 {detail},这是唯一允许两边参数不一致的情况。
const OPTIONAL_ARGS = new Set(['detail']);

/** 检查字典:每个语言键齐全、消息可解析、占位符与 en 一致。返回问题列表(空 = 通过)。 */
export function checkDictionaries(dictionaries: Record<Locale, Record<string, string>>): string[] {
    const problems: string[] = [];
    const base = dictionaries[DEFAULT_LOCALE];
    for (const locale of LOCALES) {
        const dict = dictionaries[locale];
        for (const key of Object.keys(base)) {
            const text = dict[key];
            if (text === undefined) {
                problems.push(`${locale}: missing key ${key}`);
                continue;
            }
            let args: string[];
            let baseArgs: string[];
            try {
                args = messageArgs(text);
                baseArgs = messageArgs(base[key]!);
            } catch (e) {
                problems.push(`${locale}: ${key}: ${e instanceof Error ? e.message : String(e)}`);
                continue;
            }
            const differs =
                args.filter((a) => !baseArgs.includes(a) && !OPTIONAL_ARGS.has(a)).length > 0 ||
                baseArgs.filter((a) => !args.includes(a) && !OPTIONAL_ARGS.has(a)).length > 0;
            if (differs) problems.push(`${locale}: ${key}: arguments [${args}] differ from en [${baseArgs}]`);
        }
        for (const key of Object.keys(dict)) {
            if (!(key in base)) problems.push(`${locale}: extra key ${key}`);
        }
    }
    return problems;
}
