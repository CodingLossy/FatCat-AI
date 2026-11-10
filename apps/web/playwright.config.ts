// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { defineConfig, devices } from '@playwright/test';

// 冒烟测试(ADR 0009 第 6 节):e2e/smoke.e2e.ts 自己启动构建后的 server 与假模型端点。
export default defineConfig({
    testDir: 'e2e',
    testMatch: '*.e2e.ts',
    timeout: 60_000,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['github']] : 'list',
    use: {
        ...devices['Desktop Chrome'],
        locale: 'zh-CN',
        trace: 'retain-on-failure',
    },
});
