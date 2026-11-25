// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// ownerId 覆盖检查(ADR 0051 第 3 节):packages/storage 里每个仓储方法要么参数里有 ownerId,要么登记在
// scripts/owner-scope.json,写明类别(system / child / credential / internal)和理由;登记了但代码里已经没有的条目也失败。
// 这是按 Prettier 排版的文本扫描:方法是返回对象或仓储对象里缩进 8 格的 `name(` 定义,所属对象取它上面最近的
// `const x = {` 或所在的 `export function createX`。
// 运行:node scripts/check-owner-scope.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CATEGORIES = ['system', 'child', 'credential', 'internal'];
const KEYWORDS = new Set([
    'if',
    'for',
    'while',
    'switch',
    'return',
    'catch',
    'super',
    'function',
    'await',
    'throw',
    'new',
]);

/** 扫一个文件的文本:返回 [{ key: '文件:对象.方法', owner: 参数里有没有 ownerId }]。 */
export function scanRepositorySource(file, text) {
    const lines = text.split('\n');
    const out = [];
    let factory = '';
    let object = '';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fn = /^export function (\w+)/.exec(line);
        if (fn) {
            factory = fn[1];
            object = '';
            continue;
        }
        const obj = /^ {4}const (\w+) = \{$/.exec(line);
        if (obj) {
            object = obj[1];
            continue;
        }
        if (/^ {4}return \{$/.test(line)) {
            object = '';
            continue;
        }
        const m = /^ {8}(?:async )?([A-Za-z_]\w*)(?:<[^>]*>)?\(/.exec(line);
        if (!m || KEYWORDS.has(m[1])) continue;
        // 参数可能跨行:读到括号配平为止
        let signature = line.slice(m[0].length);
        let depth = 1 + count(signature, '(') - count(signature, ')');
        for (let j = i + 1; depth > 0 && j < Math.min(lines.length, i + 20); j++) {
            signature += lines[j];
            depth += count(lines[j], '(') - count(lines[j], ')');
        }
        // 只算定义(签名后面接 `{`),不算缩进 8 格的普通调用语句
        if (!/\{\s*$/.test(signature)) continue;
        const scope = object || factory || '(top)';
        out.push({ key: `${file}:${scope}.${m[1]}`, owner: /\bownerId\b/.test(signature) });
    }
    return out;
}

function count(text, ch) {
    return text.split(ch).length - 1;
}

/** 比较扫描结果和登记表:返回问题列表。 */
export function checkOwnerScope(found, registry) {
    const errors = [];
    const listed = new Map();
    for (const entry of registry) {
        if (listed.has(entry.key)) errors.push(`${entry.key}: listed twice`);
        listed.set(entry.key, entry);
        if (!CATEGORIES.includes(entry.category)) errors.push(`${entry.key}: unknown category "${entry.category}"`);
        if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
            errors.push(`${entry.key}: give a reason (at least 10 characters)`);
        }
    }
    const seen = new Set();
    for (const { key, owner } of found) {
        if (owner) {
            if (listed.has(key)) errors.push(`${key}: takes ownerId now; remove it from scripts/owner-scope.json`);
            continue;
        }
        seen.add(key);
        if (!listed.has(key)) {
            errors.push(
                `${key}: no ownerId parameter; add ownerId, or list it in scripts/owner-scope.json with a category and reason`,
            );
        }
    }
    for (const key of listed.keys()) {
        if (!seen.has(key) && !found.some((f) => f.key === key))
            errors.push(`${key}: listed but not found in the code`);
    }
    return errors;
}

export function scanStorage(root) {
    const dir = join(root, 'packages', 'storage', 'src');
    return readdirSync(dir)
        .filter((f) => f.endsWith('.ts') && !/\.test\.ts$|^test-helpers\.ts$|^migrate\.ts$|^db\.ts$/.test(f))
        .sort()
        .flatMap((f) => scanRepositorySource(f, readFileSync(join(dir, f), 'utf8')));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const registry = JSON.parse(readFileSync(join(root, 'scripts', 'owner-scope.json'), 'utf8'));
    const found = scanStorage(root);
    const errors = checkOwnerScope(found, registry);
    if (errors.length > 0) {
        for (const e of errors) console.error(e);
        process.exit(1);
    }
    const scoped = found.filter((f) => f.owner).length;
    console.log(`check:owner-scope ok (${scoped} methods take ownerId, ${found.length - scoped} listed)`);
}
