// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
// 检查安装包版本来源一致(见 release-lib.mjs 的 checkDesktopVersion)。
// 用法:node apps/desktop/scripts/check-version.mjs [desktop-vX.Y.Z];不传标签时只检查 package.json 与 Cargo.toml 一致。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkDesktopVersion } from './release-lib.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const packageVersion = JSON.parse(readFileSync(`${desktop}package.json`, 'utf8')).version;
const cargo = readFileSync(`${desktop}src-tauri/Cargo.toml`, 'utf8');
const cargoVersion = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(cargo)?.[1];
const conf = JSON.parse(readFileSync(`${desktop}src-tauri/tauri.conf.json`, 'utf8'));

const errors = checkDesktopVersion({ packageVersion, cargoVersion, tag: process.argv[2] ?? '' });
if (conf.version !== '../package.json')
    errors.push('tauri.conf.json version must be "../package.json" (single source)');
if (errors.length > 0) {
    for (const e of errors) console.error(`version check: ${e}`);
    process.exit(1);
}
console.log(`desktop version ${packageVersion} is consistent`);
