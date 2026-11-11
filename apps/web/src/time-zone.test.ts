// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { matchTimeZone } from './time-zone.js';

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
