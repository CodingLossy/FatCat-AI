// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

/** 输入是否是列表中的时区(大小写不敏感),返回列表里的写法;不是时返回 null。 */
export function matchTimeZone(input: string, supported: readonly string[]): string | null {
    const value = input.trim().toLowerCase();
    if (!value) return null;
    return supported.find((tz) => tz.toLowerCase() === value) ?? null;
}
