// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Locale } from './locale.js';

type When = Date | number | string;
const toDate = (v: When) => (v instanceof Date ? v : new Date(v));

/** 日期时间(本地化;timeZone 缺省用运行环境的时区)。 */
export function formatDateTime(value: When, locale: Locale, timeZone?: string): string {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(toDate(value));
}

export function formatDate(value: When, locale: Locale, timeZone?: string): string {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(toDate(value));
}

export function formatTime(value: When, locale: Locale, timeZone?: string): string {
    return new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(toDate(value));
}

export function formatNumber(value: number, locale: Locale, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(locale, options).format(value);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 86_400_000],
    ['month', 30 * 86_400_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
];

/** 相对时间:「3 分钟前」/ "3 minutes ago";不足一分钟显示「现在」。 */
export function formatRelative(value: When, locale: Locale, nowMs: number = Date.now()): string {
    const diff = toDate(value).getTime() - nowMs;
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const [unit, ms] of UNITS) {
        if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
    }
    return rtf.format(0, 'second');
}
