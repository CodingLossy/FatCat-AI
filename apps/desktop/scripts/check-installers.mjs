// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
// 检查 tauri build 产出的安装包体积(每个 ≤ 80 MB,AppImage 单独 ≤ 140 MB),并写出 SHA256SUMS-<平台>。
// 用法:node apps/desktop/scripts/check-installers.mjs [bundle 目录] [输出目录]

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInstallerSizes, sha256Sums } from './release-lib.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = resolve(process.argv[2] ?? join(desktop, 'src-tauri/target/release/bundle'));
const outDir = resolve(process.argv[3] ?? join(desktop, 'dist'));

function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
}
const files = walk(bundleDir).map((path) => ({
    path,
    name: relative(bundleDir, path).replaceAll('\\', '/'),
    size: statSync(path).size,
}));
const { installers, errors } = checkInstallerSizes(files.map((f) => ({ name: f.name, size: f.size })));
for (const f of installers) console.log(`${(f.size / 1048576).toFixed(1).padStart(7)} MB  ${f.name}`);
if (errors.length > 0) {
    for (const e of errors) console.error(`check-installers FAILED: ${e}`);
    process.exit(1);
}
const entries = installers.map((i) => ({
    name: i.name.split('/').pop(),
    bytes: readFileSync(files.find((f) => f.name === i.name).path),
}));
writeFileSync(join(outDir, `SHA256SUMS-${process.platform}`), sha256Sums(entries));
console.log(`wrote SHA256SUMS-${process.platform}`);
