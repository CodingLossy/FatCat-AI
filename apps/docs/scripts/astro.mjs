// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 运行 astro,并关闭它自带的匿名使用统计:FatCat-AI 的构建不向任何地方发送数据。
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const astroBin = join(dirname(require.resolve('astro/package.json')), 'bin/astro.mjs');
const result = spawnSync(process.execPath, [astroBin, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' },
});
process.exit(result.status ?? 1);
