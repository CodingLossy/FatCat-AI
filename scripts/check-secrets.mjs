// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 扫描录制回放 fixture 中疑似凭据的内容(ADR 0006 第 3 节);fixture 落盘前应已脱敏,这里是 CI 兜底。
import { existsSync, readFileSync } from 'node:fs';
import { listRepoFiles } from './lib.mjs';

const PATTERNS = [
    ['bearer token', /\b(Bearer|Basic)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/i],
    ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{16,}/],
    ['GitHub token', /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
    ['FatCat-AI token', /\baip_pat_[A-Za-z0-9_-]{20,}/],
    ['Google API key', /\bAIza[A-Za-z0-9_-]{30,}/],
    ['Slack token', /\bxox[abpsr]-[A-Za-z0-9-]{10,}/],
    ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const files = listRepoFiles().filter((f) => /(^|\/)fixtures\//.test(f) && existsSync(f));
const hits = [];
for (const file of files) {
    readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
            for (const [label, re] of PATTERNS) if (re.test(line)) hits.push(`${file}:${i + 1}: ${label}`);
        });
}

if (hits.length > 0) {
    console.error(hits.join('\n'));
    console.error(`\n发现 ${hits.length} 处疑似凭据;fixture 必须先脱敏`);
    process.exit(1);
}
console.log(`fixture 凭据扫描通过(${files.length} 个文件)`);
