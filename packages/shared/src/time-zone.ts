// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 用户时区(ADR 0023)。Settings.timeZone 在 M5a PR 4 加入;本文件只新增 schema。
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
