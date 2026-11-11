// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

const Input = z.strictObject({
    timezone: z.string().min(1).max(64).optional(),
});

function isValidTimeZone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * time(read):当前时间,可指定 IANA 时区;不指定时用 defaultTimeZone(服务器传入用户设置的时区,ADR 0023),
 * 没有给 defaultTimeZone 时用服务器时区。
 */
export function createTimeTool(
    now: () => Date = () => new Date(),
    defaultTimeZone?: (ownerId: string) => string,
): ToolDefinition {
    return {
        name: 'time',
        description:
            'Get the current date and time. Optionally pass an IANA time zone such as "Asia/Shanghai"; ' +
            "the default is the user's time zone.",
        parameters: {
            type: 'object',
            properties: { timezone: { type: 'string', description: 'IANA time zone, e.g. Asia/Shanghai' } },
            additionalProperties: false,
        },
        risk: 'read',
        summarize: () => 'Get the current time',
        execute: async (raw, ctx) => {
            const input = Input.parse(raw ?? {});
            const timezone =
                input.timezone ?? defaultTimeZone?.(ctx.ownerId) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (!isValidTimeZone(timezone)) throw new Error(`unknown time zone: ${timezone}`);
            const date = now();
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: timezone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hourCycle: 'h23',
                weekday: 'long',
                timeZoneName: 'shortOffset',
            }).formatToParts(date);
            const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
            return {
                timezone,
                local: `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`,
                weekday: get('weekday'),
                utcOffset: get('timeZoneName'),
                iso: date.toISOString(),
                unix: Math.floor(date.getTime() / 1000),
            };
        },
    };
}
