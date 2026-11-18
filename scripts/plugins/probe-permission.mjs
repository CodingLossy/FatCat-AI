// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件隔离的平台实测(ADR 0040 第 11 节 PR 2b 的第一步):在当前平台上以第 4.1 节的参数启动探测插件,
// 逐项尝试越界访问,输出通过 / 不通过表。任何一项不通过时退出码为 1;不通过的项要降级并报业主决定。
// 用法:先 `pnpm build`,再 `node scripts/plugins/probe-permission.mjs`。Windows、Linux、macOS 各跑一次。
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { StdioMcpClient } = await import(pathToFileURL(join(root, 'packages/tools/dist/mcp/index.js')).href);
const { pluginEnv, pluginNodeArgs, preloadScriptPath, findReparsePoint } = await import(
    pathToFileURL(join(root, 'packages/tools/dist/plugins/index.js')).href
);
const fixture = join(root, 'packages/tools/src/plugins/fixtures/probe-plugin.js');

const results = [];
const record = (name, ok, detail = '') => results.push({ name, ok, detail });

// 数据目录路径含中文与空格(第 11 节的用例之一);父目录放主程序的「敏感文件」
const base = realpathSync(mkdtempSync(join(tmpdir(), 'fatcat-probe-')));
const home = join(base, '主程序 数据目录');
const codeDir = join(home, 'plugins', 'probe', '0.1.0');
const dataDir = join(home, 'plugin-data', 'probe');
const otherData = join(home, 'plugin-data', 'other');
for (const dir of [codeDir, dataDir, otherData, join(dataDir, 'home'), join(dataDir, 'tmp')]) {
    mkdirSync(dir, { recursive: true });
}
cpSync(fixture, join(codeDir, 'probe-plugin.js'));
const secretFiles = ['master.key', 'secrets.yaml.enc', 'db.sqlite'].map((name) => join(home, name));
for (const file of secretFiles) writeFileSync(file, 'SENSITIVE');
writeFileSync(join(otherData, 'data.txt'), 'other plugin');

// 数据目录里的链接:符号链接;Windows 上用 junction 指向目录。启动前检查必须能发现它们。
const links = [];
try {
    symlinkSync(secretFiles[0], join(dataDir, 'link-to-master-key'), 'file');
    links.push(join(dataDir, 'link-to-master-key'));
    symlinkSync(home, join(dataDir, 'junction-to-home'), process.platform === 'win32' ? 'junction' : 'dir');
    links.push(join(dataDir, 'junction-to-home'));
} catch (error) {
    record('create links for the test', false, `cannot create links here: ${error.message}`);
}
const found = findReparsePoint(dataDir);
record(
    'pre-start check finds symlink / junction in the data dir',
    links.length > 0 && found !== null,
    found ?? 'not found',
);
// 移走链接后才启动(有链接时服务器会拒绝启动,这里要测的是权限模型本身)
for (const link of links) rmSync(link, { recursive: true, force: true });

const client = new StdioMcpClient(
    {
        command: process.execPath,
        args: pluginNodeArgs({ codeDir, dataDir, main: 'probe-plugin.js', preload: preloadScriptPath() }),
        cwd: dataDir,
        envPassthrough: [],
        rawEnv: pluginEnv({ pluginId: 'probe', dataDir, secrets: {} }),
    },
    { timeoutMs: 20_000 },
);
const probe = async (attack, arg = '') => {
    const reply = await client.callTool('probe', { attack, arg });
    return String(reply.content?.[0]?.text ?? '');
};
const expectBlocked = async (name, attack, arg) => {
    const text = await probe(attack, arg);
    record(name, text.startsWith('blocked'), text.slice(0, 100));
};

try {
    await client.connect();
    const tools = await client.listTools();
    record('probe plugin starts under --permission with the preload script', tools.length > 0);

    // 1. 直接读主程序的文件与其他插件的数据
    for (const file of secretFiles) await expectBlocked(`read ${file.slice(home.length + 1)}`, 'read', file);
    await expectBlocked('list another plugin data dir', 'list', otherData);
    await expectBlocked('read another plugin data file', 'read', join(otherData, 'data.txt'));
    await expectBlocked('write outside the data dir', 'write', join(home, 'pwned.txt'));
    await expectBlocked('write into its own code dir', 'write', join(codeDir, 'probe-plugin.js'));

    // 2. 路径变体:../、多余的分隔符、大小写、8.3 短名、UNC
    const target = secretFiles[0];
    await expectBlocked('read via ../ traversal', 'read', join(dataDir, '..', '..', 'master.key'));
    await expectBlocked('read via redundant separators', 'read', target.replace(home, `${home}/./`));
    if (process.platform === 'win32' || process.platform === 'darwin') {
        await expectBlocked('read via different letter case', 'read', target.toUpperCase());
    }
    if (process.platform === 'win32') {
        const drive = target.slice(0, 1);
        await expectBlocked('read via \\\\?\\ path', 'read', `\\\\?\\${target}`);
        await expectBlocked(
            'read via \\\\localhost\\C$ UNC path',
            'read',
            `\\\\localhost\\${drive}$${target.slice(2)}`,
        );
        try {
            const short = execFileSync('cmd', ['/c', `for %I in ("${target}") do @echo %~sI`], {
                encoding: 'utf8',
            }).trim();
            await expectBlocked(`read via 8.3 short name (${short})`, 'read', short);
        } catch (error) {
            record('read via 8.3 short name', false, `could not compute a short name: ${error.message}`);
        }
    }

    // 3. 第 3.4 节的每个内置模块:import / 无前缀 import / require(createRequire) / getBuiltinModule
    const table = JSON.parse(await probe('builtins'));
    const allowed = Object.entries(table)
        .filter(([, v]) => v !== 'blocked')
        .map(([k]) => k);
    record(
        'all 17 denied built-in modules blocked under import, bare import, createRequire, getBuiltinModule, Module._load and data URLs',
        allowed.length === 0 && Object.keys(table).length === 119,
        allowed.join(', '),
    );
    // 绕过检查:用 Module.registerHooks 把别名指向 node:http 再连本机端口;给父进程发信号;运行中新建链接
    const local = createServer((_req, res) => res.end('SERVER-SECRET'));
    await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
    try {
        await expectBlocked('re-register module hooks to reach node:http', 'hookbypass', String(local.address().port));
    } finally {
        local.close();
    }
    const patched = createServer((_req, res) => res.end('SERVER-SECRET'));
    await new Promise((resolve) => patched.listen(0, '127.0.0.1', resolve));
    try {
        const port = String(patched.address().port);
        await expectBlocked('rewrite Module._resolveFilename to reach node:http', 'resolvepatch', port);
        await expectBlocked('rewrite Module._load to reach node:http', 'loadpatch', port);
    } finally {
        patched.close();
    }
    await expectBlocked('process._kill on the parent', 'kill2');
    await expectBlocked('Module.register', 'register');
    await expectBlocked('signal to the parent process', 'kill-parent');
    await expectBlocked('create a symlink at run time', 'symlink', secretFiles[0]);
    await expectBlocked('create a hard link at run time', 'hardlink', secretFiles[0]);
    await expectBlocked('process.binding', 'binding');
    await expectBlocked('process.dlopen', 'dlopen');
    await expectBlocked('global fetch', 'fetch');

    // 4. 环境
    const env = JSON.parse(await probe('env'));
    record(
        'environment has no FATCAT_AI_* / AIP_* / NODE_OPTIONS / NODE_PATH',
        !env.some((k) => /^(FATCAT_AI_|AIP_|NODE_OPTIONS$|NODE_PATH$)/.test(k)),
        env.join(','),
    );
} catch (error) {
    record('probe run', false, error instanceof Error ? error.message : String(error));
} finally {
    await client.shutdown(1000, 500).catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
}

const width = Math.max(...results.map((r) => r.name.length));
console.log(`\nPlatform: ${process.platform} ${process.arch}, Node ${process.version}\n`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.ok ? '' : r.detail}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
    console.log(
        'At least one check failed: downgrade that protection on this platform and report it (ADR 0040 section 11).',
    );
    process.exit(1);
}
