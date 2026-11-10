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
            // 网络与子进程部分(client / worker / run)需要真实服务器;tools / items / attachments 由服务器的邮件测试与注入评测覆盖
            exclude: [
                'src/**/*.test.ts',
                'src/client.ts',
                'src/worker.ts',
                'src/run.ts',
                'src/tools.ts',
                'src/items.ts',
                'src/attachments.ts',
            ],
            reporter: ['text-summary'],
            thresholds: { lines: 80, statements: 80 },
        },
    },
});
