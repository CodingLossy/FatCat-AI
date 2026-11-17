// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { TaskPolicy } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { parseToolSet, withToolSet } from './toolset.js';

const policy: TaskPolicy = { maxAttempts: 3, misfire: 'skip', quietHours: null, maxRuntimeMinutes: 10 };

describe('任务工具集编辑', () => {
    it('逗号、空格、换行分隔并去重;空输入表示不限制', () => {
        expect(parseToolSet('kb.search, web.  kb.search\nitems.get')).toEqual(['kb.search', 'web.', 'items.get']);
        expect(parseToolSet('  , ')).toBeUndefined();
    });

    it('写入策略;清空时去掉字段而不是留空数组', () => {
        expect(withToolSet(policy, ['kb.search']).toolSet).toEqual(['kb.search']);
        const cleared = withToolSet({ ...policy, toolSet: ['kb.search'] }, undefined);
        expect('toolSet' in cleared).toBe(false);
    });
});
