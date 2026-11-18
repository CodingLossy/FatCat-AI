// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
// 冒烟检查:用打好的 sidecar 启动核心(临时数据目录、随机端口),等 /healthz 就绪并记录耗时与内存,
// 然后关闭它的 stdin,确认进程随之退出。用法:node apps/desktop/scripts/check-sidecar.mjs [sidecar 目录]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = resolve(process.argv[2] ?? join(root, 'apps/desktop/dist/sidecar'));
const data = mkdtempSync(join(tmpdir(), 'fatcat-sidecar-'));
const port = 20000 + Math.floor(Math.random() * 20000);

const started = Date.now();
const child = spawn(process.execPath, [join(dir, 'dist/server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
        PATH: process.env['PATH'] ?? '',
        FATCAT_AI_HOST: '127.0.0.1',
        FATCAT_AI_PORT: String(port),
        FATCAT_AI_DATA_DIR: data,
        FATCAT_AI_EXIT_WITH_PARENT: '1',
    },
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
const exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));

function fail(msg) {
    console.error(`check-sidecar FAILED: ${msg}\n${log.slice(-2000)}`);
    child.kill('SIGKILL');
    rmSync(data, { recursive: true, force: true });
    process.exit(1);
}

let ready = false;
while (Date.now() - started < 30_000) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.ok) {
            ready = true;
            break;
        }
    } catch {
        /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 50));
}
if (!ready) fail('server did not become healthy within 30s');
console.log(`healthz ready in ${Date.now() - started} ms`);

child.stdin.end();
const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 15_000))]);
if (!result) fail('server did not exit after stdin closed');
console.log(`exited after stdin close (code ${result.code})`);
rmSync(data, { recursive: true, force: true });
