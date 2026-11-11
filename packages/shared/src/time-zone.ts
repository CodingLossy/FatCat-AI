// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 用户时区(ADR 0023):Settings.timeZone 的 schema 与按时区换算日期的小工具(自 M5a PR 4 起)。
import { z } from 'zod';

/**
 * 只接受 IANA 区域名(`Area/Location`,如 `Asia/Shanghai`)与 `UTC`;
 * 不接受 `+08:00` 这类固定偏移和 `CST` 这类缩写(不随夏令时变化,含义也不唯一)。
 */
const IANA_SHAPE = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;

/** 运行时能识别这个区域名时返回 true。Intl.supportedValuesOf 不含 `UTC`,所以用 DateTimeFormat 判断。 */
export function isSupportedTimeZone(name: string): boolean {
    if (!IANA_SHAPE.test(name)) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: name });
        return true;
    } catch {
        return false;
    }
}

export const TimeZoneName = z.string().max(64).refine(isSupportedTimeZone, { message: 'unknown IANA time zone' });
export type TimeZoneName = z.infer<typeof TimeZoneName>;

/** `GET /api/v1/settings/time-zones`:设置页的可选列表与「跟随服务器」时显示的服务器时区。 */
export const TimeZoneInfo = z.object({
    serverTimeZone: z.string(),
    supported: z.array(z.string()),
});
export type TimeZoneInfo = z.infer<typeof TimeZoneInfo>;

/** 服务器进程的时区;没有设置用户时区时用它(ADR 0023 第 1 节)。 */
export function serverTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** 实际生效的时区:设置了且仍能识别就用设置,否则跟随服务器。 */
export function effectiveTimeZone(setting: string | null | undefined): string {
    return setting && isSupportedTimeZone(setting) ? setting : serverTimeZone();
}

/** 设置页的可选列表:`Intl.supportedValuesOf('timeZone')` 加上 `UTC`(前者不含 `UTC`)。 */
export function supportedTimeZones(): string[] {
    const names = Intl.supportedValuesOf('timeZone');
    return names.includes('UTC') ? names : ['UTC', ...names];
}

interface LocalParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

function localParts(at: Date, timeZone: string): LocalParts {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        })
            .formatToParts(at)
            .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
    };
}

/** `at` 在某个时区中的日期 `YYYY-MM-DD`:「今天」、每日上限与维护任务的日期键都用它。 */
export function localDate(at: Date, timeZone: string): string {
    const p = localParts(at, timeZone);
    return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 某个时区中 `at` 所在这一天 00:00 对应的时刻。 */
export function startOfLocalDay(at: Date, timeZone: string): Date {
    const p = localParts(at, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offset = asUtc - Math.floor(at.getTime() / 1000) * 1000;
    return new Date(Date.UTC(p.year, p.month - 1, p.day) - offset);
}

/** 某个时区中 `at` 的下一天 00:00 对应的时刻(一天可能是 23–25 小时,所以先跳 26 小时再取当天开头)。 */
export function startOfNextLocalDay(at: Date, timeZone: string): Date {
    return startOfLocalDay(new Date(startOfLocalDay(at, timeZone).getTime() + 26 * 3_600_000), timeZone);
}

/** 系统提示里的当前时间:精确到分钟,带时区与星期(星期按界面语言)。例如「2026-11-11 15:30(Asia/Shanghai,星期三)」。 */
export function formatPromptTime(at: Date, timeZone: string, locale: string): string {
    const p = localParts(at, timeZone);
    const weekday = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'long' }).format(at);
    const hh = String(p.hour).padStart(2, '0');
    const mm = String(p.minute).padStart(2, '0');
    const date = localDate(at, timeZone);
    return locale.startsWith('zh')
        ? `${date} ${hh}:${mm}(${timeZone},${weekday})`
        : `${date} ${hh}:${mm} (${timeZone}, ${weekday})`;
}
