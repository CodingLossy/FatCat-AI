// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件内存测量(ADR 0040 第 8 节,只报告、不拦截):
//   - 主进程:没有插件时的空闲 RSS;加载插件运行时并启用一个插件后的空闲 RSS;连续 100 次工具调用后的 RSS。
//   - 插件进程:空闲 RSS;连续 100 次工具调用后的 RSS。
// 主进程这一栏测的是「一个只载入工具库与插件运行时的 Node 进程」的增量,不是完整的服务器;
// 完整服务器的数字 = 服务器空闲基线(见 pnpm perf 的其他脚本)+ 这里的增量。
// 用法:先 `pnpm build`,再 `pnpm perf:plugin`;CALLS 可改调用次数。Linux / macOS 读操作系统的数字,
// Windows 上插件进程没有读数(插件自报心跳才有,本脚本的探测插件不发心跳)。
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const CALLS = Number(process.env.CALLS ?? 100);
const mib = (bytes) => (bytes === null || bytes === undefined ? null : Math.round((bytes / 1048576) * 10) / 10);

async function child() {
    const { ToolRegistry } = await import(pathToFileURL(join(root, 'packages/tools/dist/index.js')).href);
    const settle = async () => {
        for (let i = 0; i < 3; i++) {
            globalThis.gc?.();
            await sleep(300);
        }
        return process.memoryUsage.rss();
    };
    const mainIdle = await settle();

    const { PluginRuntime, hashPluginDir } = await import(
        pathToFileURL(join(root, 'packages/tools/dist/plugins/index.js')).href
    );
    const { validatePluginManifest } = await import(pathToFileURL(join(root, 'packages/shared/dist/index.js')).href);
    const base = mkdtempSync(join(tmpdir(), 'fatcat-perf-'));
    const codeRoot = join(base, 'plugins');
    const dataRoot = join(base, 'plugin-data');
    const codeDir = join(codeRoot, 'probe', '0.1.0');
    mkdirSync(codeDir, { recursive: true });
    cpSync(join(root, 'packages/tools/src/plugins/fixtures/probe-plugin.mjs'), join(codeDir, 'probe-plugin.mjs'));
    const manifestPath = join(root, 'packages/tools/src/plugins/fixtures/plugin.json');
    writeFileSync(join(codeDir, 'plugin.json'), readFileSync(manifestPath));
    const parsed = validatePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    if (!parsed.ok) throw new Error('fixture manifest is invalid');
    const registry = new ToolRegistry();
    const runtime = new PluginRuntime({
        registry,
        codeRoot,
        dataRoot,
        env: { PATH: process.env.PATH ?? '' },
        idleMs: 3_600_000,
        onEvent: () => undefined,
        onState: () => undefined,
    });
    const status = await runtime.apply({
        ownerId: 'perf',
        pluginId: 'probe',
        version: '0.1.0',
        manifest: parsed.manifest,
        granted: parsed.manifest.permissions,
        contentSha256: hashPluginDir(codeDir),
        secretRefs: {},
        settings: {},
    });
    if (status.state !== 'running') throw new Error(`plugin did not start: ${status.error}`);
    await sleep(500);
    await runtime.checkMemory();
    const mainWithPlugin = await settle();
    const pluginIdle = runtime.status('probe').rssBytes;

    const echo = registry.get('plugin.probe.echo');
    for (let i = 0; i < CALLS; i++) await echo.execute({ text: `call ${i}` }, { ownerId: 'perf' });
    await runtime.checkMemory();
    const mainAfter = await settle();
    const pluginAfter = runtime.status('probe').rssBytes;
    const rssSource = runtime.status('probe').rssSource;
    await runtime.closeAll();
    rmSync(base, { recursive: true, force: true });
    process.stdout.write(
        `${JSON.stringify({ mainIdle, mainWithPlugin, mainAfter, pluginIdle, pluginAfter, rssSource })}\n`,
    );
}

if (process.argv[2] === 'child') {
    await child();
} else {
    const out = await new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), 'child'], {
            stdio: ['ignore', 'pipe', 'inherit'],
        });
        let text = '';
        p.stdout.on('data', (d) => (text += d));
        p.on('exit', (code) => (code === 0 ? resolve(text) : reject(new Error(`child exited with ${code}`))));
    });
    const r = JSON.parse(out.trim().split('\n').at(-1));
    const rows = [
        ['main process, no plugin (idle)', mib(r.mainIdle)],
        ['main process, runtime loaded + 1 plugin enabled (idle)', mib(r.mainWithPlugin)],
        [`main process, after ${CALLS} tool calls`, mib(r.mainAfter)],
        ['plugin process (idle)', mib(r.pluginIdle)],
        [`plugin process, after ${CALLS} tool calls`, mib(r.pluginAfter)],
    ];
    console.log(
        `\nPlatform: ${process.platform} ${process.arch}, Node ${process.version} (report only, nothing is enforced)\n`,
    );
    for (const [name, value] of rows)
        console.log(`${name.padEnd(58)} ${value === null ? 'no reading' : `${value} MiB`}`);
    console.log(`\nplugin RSS source: ${r.rssSource ?? 'none'}`);
}
