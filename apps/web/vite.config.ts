// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** 构建后把 dist/sw.js 里的 __BUILD_ID__ 换成构建产物的哈希(index.html + assets 文件名),让每次发布的缓存名都不同。 */
function serviceWorkerBuildId(): Plugin {
    let outDir = 'dist';
    return {
        name: 'fatcat-sw-build-id',
        apply: 'build',
        configResolved(config) {
            outDir = config.build.outDir;
        },
        closeBundle() {
            const hash = createHash('sha256');
            hash.update(readFileSync(join(outDir, 'index.html')));
            for (const name of readdirSync(join(outDir, 'assets')).sort()) hash.update(name);
            const file = join(outDir, 'sw.js');
            writeFileSync(file, readFileSync(file, 'utf8').replaceAll('__BUILD_ID__', hash.digest('hex').slice(0, 12)));
        },
    };
}

const SERVER = process.env.FATCAT_AI_DEV_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
    plugins: [react(), serviceWorkerBuildId()],
    server: {
        host: '127.0.0.1',
        port: 5173,
        proxy: {
            // ws: true 让开发时的 /api/v1/ws(审批面板的实时事件)也经过代理
            '/api': { target: SERVER, ws: true },
            '/healthz': SERVER,
        },
    },
});
