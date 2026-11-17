// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 服务器给出的稳定提示码(原因码、错误码、状态、确认卡提示码)在中文和英文字典里都必须有对应文字,
// 否则界面会回退到英文原文或显示键名。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TaskDraftNote, TaskErrorCode, TaskRunStatus } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { dictionaries } from './i18n.js';

const keysOf = (locale: 'zh-CN' | 'en') => new Set(Object.keys(dictionaries[locale]));

function expectBoth(keys: string[]) {
    for (const locale of ['zh-CN', 'en'] as const) {
        const have = keysOf(locale);
        expect(
            keys.filter((k) => !have.has(k)),
            locale,
        ).toEqual([]);
    }
}

describe('提示码的中英文对应', () => {
    it('任务错误码与运行状态', () => {
        expectBoth(TaskErrorCode.options.map((c) => `tasks.error.${c}`));
        expectBoth([...TaskRunStatus.options.map((c) => `tasks.status.${c}`), 'tasks.status.waiting']);
    });

    it('确认卡提示码', () => {
        expectBoth(TaskDraftNote.shape.code.options.map((c) => `tasks.note.${c}`));
    });

    it('routes/tasks.ts 里出现的每个 reason 都有中英文', () => {
        const source = readFileSync(
            fileURLToPath(new URL('../../server/src/routes/tasks.ts', import.meta.url)),
            'utf8',
        );
        const reasons = new Set([...source.matchAll(/'(task_[a-z_]+)'/g)].map((m) => m[1]!));
        // cronReason 拼出的几个码
        for (const code of ['fields', 'never', 'interval']) reasons.add(`task_cron_${code}`);
        expect(reasons.size).toBeGreaterThan(15);
        expectBoth([...reasons].map((r) => `tasks.reason.${r}`));
    });

    it('两份字典的中文提示里不含英文原文的残留占位', () => {
        for (const key of ['tasks.reason.task_cron_invalid', 'tasks.reason.task_cron_fields']) {
            expect(dictionaries['zh-CN'][key as keyof (typeof dictionaries)['zh-CN']]).toMatch(/[一-龥]/);
            expect(dictionaries['zh-CN'][key as keyof (typeof dictionaries)['zh-CN']]).not.toContain('{detail}');
        }
    });
});
