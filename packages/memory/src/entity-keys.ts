// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// entity_key 注册表与规范化(《记忆模块补充设计》第 2.2 节补充约定;我们自己维护)。
// 每个键声明 cardinality 与默认 domain;不在表中的键归一为 x.<slug>,默认 multi。
import type { Memory } from '@ai-personal/shared';

export interface EntityKeySpec {
    cardinality: Memory['cardinality'];
    domain: Memory['domain'];
}

const REGISTRY: Readonly<Record<string, EntityKeySpec>> = {
    'user.name': { cardinality: 'single', domain: 'general' },
    'user.location.city': { cardinality: 'single', domain: 'life' },
    'user.employer': { cardinality: 'single', domain: 'work' },
    'user.role': { cardinality: 'single', domain: 'work' },
    'user.timezone': { cardinality: 'single', domain: 'general' },
    'user.diet': { cardinality: 'single', domain: 'life' },
    'pref.reply_language': { cardinality: 'single', domain: 'general' },
    'pref.tone': { cardinality: 'single', domain: 'general' },
};

/** 带一段 slug 的键族:project.<slug>.status、person.<slug>.relation 等。 */
const FAMILIES: readonly [RegExp, EntityKeySpec][] = [
    [/^project\.[a-z0-9_-]+\.(?:status|license|stack)$/, { cardinality: 'single', domain: 'work' }],
    [/^person\.[a-z0-9_-]+\.relation$/, { cardinality: 'single', domain: 'life' }],
];

/** 常见的别名,归一到注册表中的键。 */
const ALIASES: Readonly<Record<string, string>> = {
    'user.city': 'user.location.city',
    'user.location': 'user.location.city',
    'user.home.city': 'user.location.city',
    'user.company': 'user.employer',
    'user.job': 'user.role',
    'user.title': 'user.role',
    'user.job_title': 'user.role',
    'user.tz': 'user.timezone',
    'pref.language': 'pref.reply_language',
    'pref.lang': 'pref.reply_language',
};

const MAX_KEY_LENGTH = 81;

/** 规范成 [a-z][a-z0-9_.-]* 的形式:小写,空白与斜杠、冒号换成点,其他字符换成下划线。 */
function slugify(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/[\s/:]+/g, '.')
        .replace(/[^a-z0-9_.-]/g, '_')
        .replace(/\.{2,}/g, '.')
        .replace(/^[^a-z]+|\.+$/g, '');
}

export interface NormalizedKey extends EntityKeySpec {
    key: string;
    /** 是否在注册表或键族中。 */
    known: boolean;
}

/** 规范化 entity_key;规范化后为空时返回 null(当作没有键)。 */
export function normalizeEntityKey(raw: string): NormalizedKey | null {
    const slug = slugify(raw);
    if (slug.length < 2) return null;
    const key = ALIASES[slug] ?? slug;
    const spec = REGISTRY[key] ?? FAMILIES.find(([re]) => re.test(key))?.[1];
    if (spec) return { key, ...spec, known: true };
    const unknown = (key.startsWith('x.') ? key : `x.${key}`).slice(0, MAX_KEY_LENGTH).replace(/\.+$/, '');
    return { key: unknown, cardinality: 'multi', domain: 'general', known: false };
}

/** 画像与偏好类的单值键:更替它们需要审批(ADR 0010 第 4 节)。 */
export function isProfileKey(key: string | null | undefined): boolean {
    return !!key && (key.startsWith('user.') || key.startsWith('pref.'));
}
