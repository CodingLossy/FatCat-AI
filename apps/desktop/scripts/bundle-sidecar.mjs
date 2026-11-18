// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
// 把已构建的核心服务打成 sidecar 目录:dist/sidecar/{package.json, dist/*, node_modules/better-sqlite3}。
// 用法:pnpm build 之后运行 node apps/desktop/scripts/bundle-sidecar.mjs [输出目录]

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(process.argv[2] ?? join(root, 'apps/desktop/dist/sidecar'));

const entries = {
    server: join(root, 'apps/server/dist/index.js'),
    'mail-worker': join(root, 'packages/mail/dist/worker.js'),
    'docs-worker': join(root, 'packages/tools/dist/docs/worker.js'),
};
for (const file of Object.values(entries)) {
    if (!existsSync(file)) throw new Error(`missing ${file}; run pnpm build first`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });

await build({
    entryPoints: entries,
    outdir: join(out, 'dist'),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    minify: true,
    legalComments: 'none',
    // 原生模块不能打进单文件,随包携带。
    external: ['better-sqlite3'],
    banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'warning',
});

// 插件沙箱预加载脚本:与入口并列(preloadScriptPath 先找同目录 preload.js)。
cpSync(join(root, 'packages/tools/dist/plugins/preload.js'), join(out, 'dist/preload.js'));
// 版本号读取 ../package.json。
const serverPkg = JSON.parse(readFileSync(join(root, 'apps/server/package.json'), 'utf8'));
writeFileSync(
    join(out, 'package.json'),
    JSON.stringify({ name: serverPkg.name, version: serverPkg.version, type: 'module' }, null, 2) + '\n',
);

// 只拷运行需要的部分(lib、package.json、LICENSE)和当前平台的 prebuild;各平台由 CI 矩阵分别生成。
const req = createRequire(join(root, 'packages/storage/package.json'));
const bsDir = dirname(req.resolve('better-sqlite3/package.json'));
const dest = join(out, 'node_modules/better-sqlite3');
mkdirSync(dest, { recursive: true });
for (const name of ['lib', 'package.json', 'LICENSE']) cpSync(join(bsDir, name), join(dest, name), { recursive: true });
const target = `${process.platform}-${process.arch}`;
const prebuild = join(bsDir, 'prebuilds', `${target}.node`);
if (!existsSync(prebuild)) throw new Error(`no better-sqlite3 prebuild for ${target}`);
mkdirSync(join(dest, 'prebuilds'), { recursive: true });
cpSync(prebuild, join(dest, 'prebuilds', `${target}.node`));
console.log(`sidecar staged at ${out}`);
