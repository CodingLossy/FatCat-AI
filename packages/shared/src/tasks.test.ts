// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { TaskPolicy, toolInSet } from './tasks.js';

describe('任务工具集', () => {
    it('完整名字精确匹配;以 . 结尾的前缀匹配整组,不会误伤同前缀的别的名字', () => {
        expect(toolInSet('kb.search', ['kb.search'])).toBe(true);
        expect(toolInSet('kb.search_all', ['kb.search'])).toBe(false);
        expect(toolInSet('web.fetch', ['web.'])).toBe(true);
        expect(toolInSet('webhook.send', ['web.'])).toBe(false);
        expect(toolInSet('items.get', ['kb.search', 'web.'])).toBe(false);
    });

    it('toolSet 是可选字段:缺省合法,空数组不合法', () => {
        const base = { maxAttempts: 3, misfire: 'skip', quietHours: null, maxRuntimeMinutes: 10 };
        expect(TaskPolicy.safeParse(base).success).toBe(true);
        expect(TaskPolicy.safeParse({ ...base, toolSet: ['kb.search', 'web.'] }).success).toBe(true);
        expect(TaskPolicy.safeParse({ ...base, toolSet: [] }).success).toBe(false);
    });
});
