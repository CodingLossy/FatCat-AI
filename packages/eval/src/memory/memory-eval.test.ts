// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// `pnpm eval`:运行记忆评测集并输出召回率 / 过时率 / 错误率(回放模式,不调用真实模型)。
import { describe, expect, it } from 'vitest';
import { MEMORY_CASES } from './cases.js';
import { formatReport, runMemoryEval } from './run.js';

describe('记忆评测集', () => {
    it('≥ 30 条中文用例,覆盖六类;全部通过', async () => {
        expect(MEMORY_CASES.length).toBeGreaterThanOrEqual(30);
        expect(new Set(MEMORY_CASES.map((c) => c.category))).toEqual(
            new Set(['recall', 'supersede', 'conflict', 'injection', 'credential', 'stale']),
        );
        const report = await runMemoryEval();
        console.log(formatReport(report));
        expect(report.results.filter((r) => !r.pass)).toEqual([]);
        expect(report.recall).toBe(1);
        expect(report.staleRate).toBe(0);
        expect(report.errorRate).toBe(0);
    }, 60_000);
});
