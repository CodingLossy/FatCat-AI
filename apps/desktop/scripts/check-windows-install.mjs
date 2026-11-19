// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
// Windows 安装冒烟检查(只在 windows-latest 上跑,见 desktop-release.yml):
// 把 NSIS 安装包静默装到「含空格和中文」的目录,不设任何 FATCAT_AI_* 覆盖变量直接启动,等 /healthz 返回 200;
// 确认 sidecar 没有控制台子进程(conhost);强杀壳后 sidecar 必须退出。数据目录指向临时目录,不碰真实数据。
// 前置:已 `tauri build`。用法:node apps/desktop/scripts/check-windows-install.mjs

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
    console.error('check-windows-install only runs on Windows');
    process.exit(2);
}

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nsisDir = join(desktop, 'src-tauri/target/release/bundle/nsis');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一段 PowerShell,把输出当 JSON 解析(空输出返回 [])。
 * missingOk:查询「可能查不到」的对象(进程、端口)时用。`-ErrorAction SilentlyContinue` 查不到时不输出,
 * 但会把 `$?` 置为 false,powershell -Command 因此以 1 退出,execFileSync 会把「查不到」当成异常抛出。
 * 这时在末尾 `exit 0`,让「没有输出」只表示「没有这个对象」。
 */
function ps(script, { missingOk = false } = {}) {
    const command = missingOk ? `${script}; exit 0` : script;
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
    }).trim();
    if (!out) return [];
    const value = JSON.parse(out);
    return Array.isArray(value) ? value : [value];
}

function children(pid, name) {
    return ps(
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid} AND Name='${name}'" | Select-Object ProcessId | ConvertTo-Json -Compress`,
    ).map((p) => p.ProcessId);
}

/** 进程还在就返回 { Id, ProcessName },查不到(已退出)返回 null。 */
function processInfo(pid) {
    return (
        ps(
            `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object Id, ProcessName | ConvertTo-Json -Compress`,
            { missingOk: true },
        )[0] ?? null
    );
}

async function waitFor(cond, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = await cond();
        if (v) return v;
        await sleep(500);
    }
    return null;
}

const setup = readdirSync(nsisDir).find((f) => f.toLowerCase().endsWith('-setup.exe'));
if (!setup) throw new Error(`no NSIS setup .exe in ${nsisDir}`);

const root = mkdtempSync(join(tmpdir(), 'fatcat-win-'));
const installDir = join(root, '程序 文件', 'FatCat AI');
const appData = join(root, 'appdata');
mkdirSync(appData, { recursive: true });
let shell;
let ok = false;
try {
    // NSIS 要求 /D= 是最后一个参数且不能带引号,路径里有空格时必须原样拼进命令行。
    const install = spawnSync(join(nsisDir, setup), ['/S', `/D=${installDir}`], {
        windowsVerbatimArguments: true,
        timeout: 180_000,
    });
    if (install.status !== 0) throw new Error(`installer exited with ${install.status}`);
    const exe = readdirSync(installDir).find(
        (f) => f.toLowerCase().endsWith('.exe') && !f.toLowerCase().startsWith('uninstall'),
    );
    if (!exe) throw new Error(`no app .exe in ${installDir}`);
    console.log(`installed ${exe} to ${installDir}`);

    // 不设任何 FATCAT_AI_* 覆盖变量:走的就是用户双击后的路径。
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FATCAT_AI_')));
    env.APPDATA = appData;
    env.LOCALAPPDATA = join(root, 'localappdata');
    shell = spawn(join(installDir, exe), [], { env, stdio: 'ignore' });
    const shellPid = shell.pid;

    const nodePid = await waitFor(() => children(shellPid, 'node.exe')[0], 60_000);
    if (!nodePid)
        throw new Error(
            'shell never started the bundled node.exe (check %APPDATA%\\ai.fatcat.desktop\\logs\\sidecar.log)',
        );
    console.log(`sidecar pid ${nodePid}`);

    const port = await waitFor(
        () =>
            ps(
                `Get-NetTCPConnection -State Listen -OwningProcess ${nodePid} -ErrorAction SilentlyContinue | Select-Object LocalPort | ConvertTo-Json -Compress`,
                { missingOk: true },
            )[0]?.LocalPort,
        60_000,
    );
    if (!port) throw new Error('sidecar never listened on a port');
    const healthy = await waitFor(
        () =>
            fetch(`http://127.0.0.1:${port}/healthz`).then(
                (r) => r.ok,
                () => false,
            ),
        30_000,
    );
    if (!healthy) throw new Error(`/healthz on port ${port} never returned 200`);
    console.log(`healthz 200 on port ${port}`);

    const consoles = children(nodePid, 'conhost.exe');
    if (consoles.length > 0) throw new Error(`sidecar owns a console window (conhost pid ${consoles.join(', ')})`);
    console.log('sidecar has no console window');

    // 强杀壳本身(不带子进程树),模拟崩溃:sidecar 必须自己退出。
    execFileSync('taskkill', ['/F', '/PID', String(shellPid)]);
    // 查不到进程 = 已退出 = 通过;只有 15 秒后进程仍在才失败。
    if (!(await waitFor(() => processInfo(nodePid) === null, 15_000))) {
        const left = processInfo(nodePid);
        if (left) throw new Error(`sidecar survived the shell: ${left.ProcessName} (pid ${left.Id}) is still running`);
    }
    console.log('sidecar exited after the shell was killed');
    ok = true;
} catch (error) {
    console.error(`check-windows-install FAILED: ${error.message}`);
    try {
        console.error(readFileSync(join(appData, 'ai.fatcat.desktop', 'logs', 'sidecar.log'), 'utf8').slice(-2000));
    } catch {
        /* 没有日志 */
    }
} finally {
    try {
        shell?.kill();
    } catch {
        /* 已退出 */
    }
    try {
        spawnSync(join(installDir, 'uninstall.exe'), ['/S'], { timeout: 60_000 });
    } catch {
        /* 没装成功 */
    }
    await sleep(1000);
    rmSync(root, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
