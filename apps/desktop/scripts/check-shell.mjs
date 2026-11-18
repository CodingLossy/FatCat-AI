// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
// 桌面壳冒烟检查(仅 Linux,需要 xvfb-run):启动壳,等 sidecar 出现并健康;SIGKILL 壳后 sidecar 必须自行退出。
// 前置:已 pnpm build、已 bundle-sidecar、已 cargo build。用法:node apps/desktop/scripts/check-shell.mjs

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sidecarDir = join(desktop, 'dist/sidecar');
const binary = join(desktop, 'src-tauri/target/debug/fatcat-ai-desktop');
const home = mkdtempSync(join(tmpdir(), 'fatcat-shell-'));
const marker = join(sidecarDir, 'dist/server.mjs');

function sidecarPids() {
    try {
        return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch {
        return [];
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (cond()) return true;
        await sleep(100);
    }
    return false;
}

const shell = spawn('xvfb-run', ['-a', binary], {
    stdio: 'ignore',
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, 'data'), FATCAT_AI_SIDECAR_DIR: sidecarDir },
});
let ok = false;
try {
    if (!(await waitFor(() => sidecarPids().length > 0, 30_000))) throw new Error('sidecar never started');
    console.log('shell started the sidecar');
    // 杀掉壳本身(不是 xvfb-run 包装),模拟崩溃。
    execFileSync('pkill', ['-9', '-f', `^${binary}`]);
    if (!(await waitFor(() => sidecarPids().length === 0, 15_000))) throw new Error('sidecar survived the shell');
    console.log('sidecar exited after the shell was killed');
    ok = true;
} catch (error) {
    console.error(`check-shell FAILED: ${error.message}`);
} finally {
    shell.kill('SIGKILL');
    try {
        execFileSync('pkill', ['-9', '-f', marker]);
    } catch {
        /* 已退出 */
    }
    rmSync(home, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
