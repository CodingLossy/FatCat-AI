// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { inQuietHours, nextTriggerTime, quietEnd, retryDelayMs, validateCron } from './time.js';

describe('调度的时间计算', () => {
    it('cron 校验:5 段、最小间隔 1 分钟、不接受秒级与非法表达式', () => {
        expect(validateCron('30 3 * * *', 'UTC')).toBeNull();
        expect(validateCron('*/5 * * * *', 'UTC')).toBeNull();
        expect(validateCron('* * * * * *', 'UTC')).toMatch(/5 fields/);
        expect(validateCron('61 * * * *', 'UTC')).not.toBeNull();
        expect(validateCron('not a cron', 'UTC')).not.toBeNull();
    });

    it('下一次触发按用户时区;一次性任务过了就是 null', () => {
        const next = nextTriggerTime(
            { kind: 'cron', expression: '0 8 * * *' },
            'Asia/Shanghai',
            new Date('2026-11-15T23:00:00Z'),
        );
        expect(next?.toISOString()).toBe('2026-11-16T00:00:00.000Z'); // 08:00 上海 = 00:00 UTC
        const once = { kind: 'once', at: '2026-11-16T12:00:00.000Z' } as const;
        expect(nextTriggerTime(once, 'UTC', new Date('2026-11-16T11:00:00Z'))?.toISOString()).toBe(
            '2026-11-16T12:00:00.000Z',
        );
        expect(nextTriggerTime(once, 'UTC', new Date('2026-11-16T12:00:00Z'))).toBeNull();
    });

    it('静默时段可跨午夜,结束时刻在用户时区', () => {
        const quiet = { start: '22:00', end: '07:00' };
        expect(inQuietHours(new Date('2026-11-16T15:00:00Z'), quiet, 'UTC')).toBe(false);
        expect(inQuietHours(new Date('2026-11-16T23:30:00Z'), quiet, 'UTC')).toBe(true);
        expect(inQuietHours(new Date('2026-11-16T06:59:00Z'), quiet, 'UTC')).toBe(true);
        expect(inQuietHours(new Date('2026-11-16T07:00:00Z'), quiet, 'UTC')).toBe(false);
        // 上海 23:30 在静默内;结束是次日 07:00 上海时间 = 前一日 23:00 UTC
        const at = new Date('2026-11-16T15:30:00Z');
        expect(inQuietHours(at, quiet, 'Asia/Shanghai')).toBe(true);
        expect(quietEnd(at, quiet, 'Asia/Shanghai').toISOString()).toBe('2026-11-16T23:00:00.000Z');
        expect(inQuietHours(at, { start: '08:00', end: '08:00' }, 'UTC')).toBe(false);
    });

    it('失败重试的间隔是 1、5、15 分钟,之后保持 15 分钟', () => {
        expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([60_000, 300_000, 900_000, 900_000]);
    });
});
