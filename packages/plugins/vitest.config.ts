// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { defineConfig } from 'vitest/config';

// 覆盖率门禁(开发计划第 11 节:核心包覆盖率 ≥ 80%;M2 方案问题 13):行与语句 ≥ 80%,分支暂不设门槛。
export default defineConfig({
    test: {
        coverage: {
            enabled: true,
            provider: 'v8',
            include: ['src/**/*.ts'],
            // 插件服务、市场与插件条目由 apps/server 经 HTTP 的集成测试覆盖(plugins.test.ts、plugin-market.test.ts、
            // skills.eval.test.ts),那边跑的是构建产物,算不进这里的覆盖率(ADR 0050 第 3 节)
            exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/service.ts', 'src/market.ts', 'src/items.ts'],
            reporter: ['text-summary'],
            thresholds: { lines: 80, statements: 80 },
        },
    },
});
