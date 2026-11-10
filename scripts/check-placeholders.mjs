// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 检查仓库中是否残留模板占位符(计划 15.9)。templates/ 与 docs/plan/ 是模板来源,不检查。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { listRepoFiles } from './lib.mjs';

const PLACEHOLDERS = [
    '<作者名>',
    '<商务邮箱>',
    '<邮箱>',
    '<年份>',
    '<N>',
    '<owner>',
    '<OWNER>',
    'YOUR_NAME',
    'YOUR_EMAIL',
    'TODO_PLACEHOLDER',
];
const SKIP_PREFIXES = ['templates/', 'docs/plan/', 'scripts/check-placeholders.mjs', 'pnpm-lock.yaml'];
const MAX_SIZE = 2 * 1024 * 1024;

const hits = [];
for (const file of listRepoFiles()) {
    if (SKIP_PREFIXES.some((p) => file.startsWith(p)) || !existsSync(file) || statSync(file).size > MAX_SIZE) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        for (const p of PLACEHOLDERS) {
            if (line.includes(p)) hits.push(`${file}:${i + 1}: ${p}`);
        }
    });
}

if (hits.length > 0) {
    console.error(hits.join('\n'));
    console.error(`\n发现 ${hits.length} 处占位符残留`);
    process.exit(1);
}
console.log('占位符检查通过');
