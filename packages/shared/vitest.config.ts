// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { defineConfig } from 'vitest/config';

// 覆盖率门禁(开发计划第 11 节:核心包覆盖率 ≥ 80%;M2 方案问题 13):行与语句 ≥ 80%,分支暂不设门槛。
export default defineConfig({
    test: {
        coverage: {
            enabled: true,
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/test-helpers.ts'],
            reporter: ['text-summary'],
            thresholds: { lines: 80, statements: 80 },
        },
    },
});
