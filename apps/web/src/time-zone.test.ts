// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { formatInTimeZone, matchTimeZone } from './time-zone.js';

describe('matchTimeZone', () => {
    const list = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles'];
    it('只接受列表中的时区,大小写不敏感,返回列表里的写法', () => {
        expect(matchTimeZone('asia/shanghai', list)).toBe('Asia/Shanghai');
        expect(matchTimeZone(' UTC ', list)).toBe('UTC');
        expect(matchTimeZone('Asia/Shang', list)).toBeNull();
        expect(matchTimeZone('+08:00', list)).toBeNull();
        expect(matchTimeZone('', list)).toBeNull();
    });
});

describe('formatInTimeZone', () => {
    const iso = '2026-11-18T16:00:00Z'; // 洛杉矶 08:00,北京 00:00(次日)
    it('按任务时区显示;浏览器时区不同再附本地时间', () => {
        const r = formatInTimeZone(iso, 'America/Los_Angeles', 'en-US', 'Asia/Shanghai');
        expect(r.main).toContain('8:00:00 AM');
        expect(r.local).toContain('12:00:00 AM');
    });
    it('时区相同、未知或无效时不附本地时间,也不抛错', () => {
        expect(formatInTimeZone(iso, 'Asia/Shanghai', 'en-US', 'Asia/Shanghai').local).toBeNull();
        expect(formatInTimeZone(iso, undefined, 'en-US', 'Asia/Shanghai').local).toBeNull();
        expect(() => formatInTimeZone(iso, 'Not/AZone', 'en-US', 'Asia/Shanghai')).not.toThrow();
    });
});
