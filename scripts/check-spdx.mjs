// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// REUSE-IgnoreStart(下面的代码包含 SPDX 关键字,避免被 reuse 误解析)
// 检查每个源文件开头的 SPDX 许可证头与版权行,以及各 package.json 的 license / author 字段。
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { AUTHOR, COPYRIGHT, expectedLicense, listRepoFiles } from './lib.mjs';

const SOURCE_EXT = new Set([
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.mjs',
    '.cjs',
    '.css',
    '.html',
    '.yml',
    '.yaml',
    '.sh',
    '.rs',
    '.py',
]);
const SOURCE_NAMES = new Set(['Dockerfile', '.dockerignore']);
const SKIP_PREFIXES = ['templates/', 'docs/plan/', 'LICENSES/'];
const HEADER_LINES = 6;

const errors = [];
const files = listRepoFiles().filter((f) => existsSync(f) && !SKIP_PREFIXES.some((p) => f.startsWith(p)));

for (const file of files) {
    const name = basename(file);
    if (name === 'pnpm-lock.yaml') continue;
    if (name === 'package.json') {
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        const want = expectedLicense(file);
        if (pkg.license !== want) errors.push(`${file}: license 应为 "${want}",实际为 "${pkg.license}"`);
        if (pkg.author !== AUTHOR) errors.push(`${file}: author 应为 "${AUTHOR}"`);
        continue;
    }
    if (!SOURCE_EXT.has(extname(file)) && !SOURCE_NAMES.has(name)) continue;

    const head = readFileSync(file, 'utf8').split('\n').slice(0, HEADER_LINES).join('\n');
    const want = expectedLicense(file);
    const match = head.match(/SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/);
    if (!match) {
        errors.push(`${file}: 缺少 SPDX-License-Identifier 头`);
    } else if (match[1] !== want) {
        errors.push(`${file}: SPDX 应为 ${want},实际为 ${match[1]}`);
    }
    if (!head.includes(COPYRIGHT)) errors.push(`${file}: 缺少版权行 "${COPYRIGHT}"`);
}

if (errors.length > 0) {
    console.error(errors.join('\n'));
    console.error(`\nSPDX 检查失败:${errors.length} 处问题。模板见 templates/FILE-HEADER.txt`);
    process.exit(1);
}
console.log(`SPDX 检查通过(${files.length} 个文件)`);
// REUSE-IgnoreEnd
