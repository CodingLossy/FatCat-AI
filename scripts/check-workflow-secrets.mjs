// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 项目约定:任何签名私钥都不进仓库,也不进 GitHub Secrets(ADR 0044 第 7 节)。
// 这里扫描 .github/workflows/ 下的工作流:出现 `secrets.*PRIVATE_KEY*` 引用或 TAURI_SIGNING_PRIVATE_KEY 就失败。
// 运行:node scripts/check-workflow-secrets.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_REF = /secrets\s*(?:\.|\[\s*['"])\s*[A-Za-z0-9_]*PRIVATE_KEY/i;
const TAURI_KEY = /TAURI_SIGNING_PRIVATE_KEY/;

/** 返回文本里违规的行(行号从 1 开始);YAML 注释行不算。 */
export function findPrivateKeySecretRefs(text) {
    const hits = [];
    text.split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('#')) return;
        if (SECRET_REF.test(line) || TAURI_KEY.test(line)) hits.push({ line: i + 1, text: line.trim() });
    });
    return hits;
}

export function checkWorkflowSecrets(root) {
    const dir = join(root, '.github/workflows');
    const problems = [];
    for (const name of readdirSync(dir)) {
        if (!/\.ya?ml$/.test(name)) continue;
        for (const hit of findPrivateKeySecretRefs(readFileSync(join(dir, name), 'utf8'))) {
            problems.push(`.github/workflows/${name}:${hit.line}: private key secret reference: ${hit.text}`);
        }
    }
    return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const problems = checkWorkflowSecrets(fileURLToPath(new URL('..', import.meta.url)));
    if (problems.length > 0) {
        console.error(problems.join('\n'));
        console.error('签名私钥只能留在业主本机,不得放进 GitHub Secrets(见 ADR 0044)。');
        process.exit(1);
    }
    console.log('check:workflow-secrets ok');
}
