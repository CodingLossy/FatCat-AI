// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SETTINGS,
    effectiveTimeZone,
    formatPromptTime,
    localDate,
    SettingsPatch,
    startOfLocalDay,
    startOfNextLocalDay,
    supportedTimeZones,
} from './index.js';

// 2026-11-10 17:00 UTC = 上海 11 日 01:00(ADR 0023 第 6 节)
const AT = new Date('2026-11-10T17:00:00Z');

describe('user time zone (ADR 0023)', () => {
    it('「今天」按用户时区跨日', () => {
        expect(localDate(AT, 'UTC')).toBe('2026-11-10');
        expect(localDate(AT, 'Asia/Shanghai')).toBe('2026-11-11');
        expect(startOfLocalDay(AT, 'Asia/Shanghai').toISOString()).toBe('2026-11-10T16:00:00.000Z');
        expect(startOfLocalDay(AT, 'UTC').toISOString()).toBe('2026-11-10T00:00:00.000Z');
    });

    it('下一天的开头:夏令时结束那天是 25 小时', () => {
        // 2026-11-01 洛杉矶夏令时结束;当天 00:00 是 07:00Z,次日 00:00 是 08:00Z
        expect(startOfNextLocalDay(new Date('2026-11-01T12:00:00Z'), 'America/Los_Angeles').toISOString()).toBe(
            '2026-11-02T08:00:00.000Z',
        );
        expect(startOfNextLocalDay(AT, 'Asia/Shanghai').toISOString()).toBe('2026-11-11T16:00:00.000Z');
    });

    it('设置为 null 或已不能识别时跟随服务器', () => {
        const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
        expect(effectiveTimeZone(null)).toBe(server);
        expect(effectiveTimeZone('Mars/Olympus')).toBe(server);
        expect(effectiveTimeZone('Asia/Calcutta')).toBe('Asia/Calcutta');
    });

    it('可选列表含 UTC;默认跟随服务器;补丁接受 null、拒绝缩写', () => {
        expect(supportedTimeZones()).toContain('UTC');
        expect(supportedTimeZones()).toContain('Asia/Shanghai');
        expect(DEFAULT_SETTINGS.timeZone).toBeNull();
        expect(SettingsPatch.parse({ timeZone: null })).toEqual({ timeZone: null });
        expect(SettingsPatch.safeParse({ timeZone: 'CST' }).success).toBe(false);
    });

    it('系统提示里的时间只到分钟,星期跟随语言', () => {
        expect(formatPromptTime(AT, 'Asia/Shanghai', 'zh-CN')).toBe('2026-11-11 01:00(Asia/Shanghai,星期三)');
        expect(formatPromptTime(AT, 'UTC', 'en')).toBe('2026-11-10 17:00 (UTC, Tuesday)');
    });
});
