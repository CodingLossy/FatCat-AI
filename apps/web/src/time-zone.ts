// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

/** 输入是否是列表中的时区(大小写不敏感),返回列表里的写法;不是时返回 null。 */
export function matchTimeZone(input: string, supported: readonly string[]): string | null {
    const value = input.trim().toLowerCase();
    if (!value) return null;
    return supported.find((tz) => tz.toLowerCase() === value) ?? null;
}

/** 浏览器所在的时区(IANA 名);取不到时返回 null。 */
export function browserTimeZone(): string | null {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
        return null;
    }
}

/**
 * 把一个时刻按任务的时区显示,例如 `2026/11/18 08:00`;任务时区与浏览器时区不同时,再附一个本地时间。
 * 返回 `{ main, local }`:`local` 为 null 表示两个时区相同(或其中一个未知)。无效的时区回退到浏览器时区。
 */
export function formatInTimeZone(
    iso: string,
    timeZone: string | undefined,
    locale: string,
    browserZone: string | null = browserTimeZone(),
): { main: string; local: string | null } {
    const date = new Date(iso);
    const fmt = (tz?: string) => {
        try {
            return date.toLocaleString(locale, tz ? { timeZone: tz } : undefined);
        } catch {
            return date.toLocaleString(locale);
        }
    };
    const main = fmt(timeZone);
    if (!timeZone || !browserZone || timeZone === browserZone) return { main, local: null };
    const local = fmt(browserZone);
    return { main, local: local === main ? null : local };
}
