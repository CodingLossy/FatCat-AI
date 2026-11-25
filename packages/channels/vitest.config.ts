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
            // src/hub/test-harness.ts 是中枢单测的共用替身(ADR 0052 第 6 节),和 testing.ts 一样不计入;
            // 微信扫码授权(src/hub/wechat-channels.ts)由 apps/server 的 wechat-login.test.ts 经 HTTP 覆盖,
            // 那边跑的是构建产物,算不进这里(ADR 0050 第 2 节)
            exclude: ['src/**/*.test.ts', 'src/testing.ts', 'src/qq-fake.ts', 'src/hub/test-harness.ts', 'src/hub/wechat-channels.ts'],
            reporter: ['text-summary'],
            thresholds: { lines: 80, statements: 80 },
        },
    },
});
