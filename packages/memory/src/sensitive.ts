// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 写入时脱敏(《记忆模块补充设计》第 3 节第 2 条):sensitivity 2 的内容在写入前就替换成占位文字,
// 原文不进入记忆表、FTS、向量与摘录;sensitivity 1(生日、家庭成员等)只做标记,不替换。
// 纯函数,不依赖任何包;规则由本项目自行编写。

export type SensitiveKind = 'bank_card' | 'id_card' | 'phone' | 'address' | 'personal';

export interface Redaction {
    /** 脱敏后的文本。 */
    text: string;
    /** 0 普通、1 个人、2 敏感(已脱敏)。 */
    sensitivity: 0 | 1 | 2;
    /** 命中的类型(去重,按发现顺序)。 */
    kinds: SensitiveKind[];
}

/** Luhn 校验(银行卡号)。 */
export function luhnValid(digits: string): boolean {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let d = Number(digits[digits.length - 1 - i]);
        if (i % 2 === 1) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
    }
    return sum % 10 === 0;
}

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = '10X98765432';

/** 18 位居民身份证号的校验位(GB 11643)与出生日期的基本合法性。 */
export function chineseIdValid(id: string): boolean {
    if (!/^\d{17}[\dX]$/i.test(id)) return false;
    const month = Number(id.slice(10, 12));
    const day = Number(id.slice(12, 14));
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += Number(id[i]) * ID_WEIGHTS[i]!;
    return ID_CHECK[sum % 11] === id[17]!.toUpperCase();
}

const last4 = (digits: string) => digits.slice(-4);

/** 身份证号:前后不能紧挨数字。 */
const ID_RE = /(?<![\dXx])\d{17}[\dXx](?![\dXx])/g;
/** 银行卡号:13–19 位,可按组用空格或连字符分开。 */
const CARD_RE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
/** 中国大陆手机号,可带 +86,可按 3-4-4 分组。 */
const PHONE_RE = /(?<![\d+])(?:\+?86[ -]?)?1[3-9]\d(?:[ -]?\d{4}){2}(?!\d)/g;

const CJK = '\\u4e00-\\u9fa5';
const NUM = '(?:\\d+|[一二三四五六七八九十百]+)';
/** 详细住址:路 / 街 / 巷 + 门牌号(可带楼栋、单元、室);或小区 / 公寓 + 楼栋号;英文门牌 + 街道。 */
const ADDRESS_RES = [
    new RegExp(
        `[${CJK}]{2,5}?(?:路|街|大道|大街|巷|弄|胡同)\\s?${NUM}(?:-\\d+)?\\s?号(?:院|楼)?` +
            `(?:[${CJK}A-Za-z0-9]{0,8}?${NUM}(?:栋|幢|号楼|座|单元|层|楼|室|号))*`,
        'g',
    ),
    new RegExp(
        `[${CJK}A-Za-z0-9]{2,6}?(?:小区|花园|公寓|大厦|新村|家园|苑|社区)` +
            `[${CJK}A-Za-z0-9-]{0,4}?${NUM}(?:栋|幢|号楼|座|期)(?:${NUM}(?:单元|层|楼|室|号))*`,
        'g',
    ),
    /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct)\b\.?(?:,?\s*(?:Apt|Unit|Suite|#)\s*\w+)?/g,
];

/** sensitivity 1:生日与家庭成员等个人信息(只标记,默认不进群聊上下文,补充设计第 4.4 节)。 */
const PERSONAL_RE =
    /生日|出生于|出生日期|birthday|date of birth|\bborn on\b|我(?:的)?(?:妈妈|母亲|爸爸|父亲|老婆|妻子|老公|丈夫|儿子|女儿|孩子|哥哥|姐姐|弟弟|妹妹|爷爷|奶奶|外公|外婆)|\bmy (?:wife|husband|son|daughter|mother|father|mom|dad|kids?|children|partner)\b/i;

/** 把 text 中的敏感片段换成占位文字,返回脱敏后的文本与敏感级别。 */
export function redactSensitive(text: string): Redaction {
    const kinds: SensitiveKind[] = [];
    const hit = (kind: SensitiveKind) => {
        if (!kinds.includes(kind)) kinds.push(kind);
    };
    let out = text.replace(ID_RE, (m) => {
        if (!chineseIdValid(m)) return m;
        hit('id_card');
        return '[身份证 已隐藏]';
    });
    out = out.replace(CARD_RE, (m) => {
        const digits = m.replace(/[ -]/g, '');
        if (!luhnValid(digits)) return m;
        hit('bank_card');
        return `[银行卡 ****${last4(digits)}]`;
    });
    out = out.replace(PHONE_RE, (m) => {
        hit('phone');
        return `[手机号 ****${last4(m.replace(/\D/g, ''))}]`;
    });
    for (const re of ADDRESS_RES) {
        out = out.replace(re, () => {
            hit('address');
            return '[详细住址]';
        });
    }
    const severe = kinds.length > 0;
    if (PERSONAL_RE.test(out)) hit('personal');
    return { text: out, sensitivity: severe ? 2 : kinds.length > 0 ? 1 : 0, kinds };
}

/** 递归脱敏 JSON 值中的字符串;返回新值与其中最高的敏感级别。 */
export function redactSensitiveIn(value: Record<string, unknown>): {
    value: Record<string, unknown>;
    sensitivity: 0 | 1 | 2;
} {
    let sensitivity: 0 | 1 | 2 = 0;
    const walk = (v: unknown): unknown => {
        if (typeof v === 'string') {
            const r = redactSensitive(v);
            if (r.sensitivity > sensitivity) sensitivity = r.sensitivity;
            return r.text;
        }
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
        return v;
    };
    return { value: walk(value) as Record<string, unknown>, sensitivity };
}
