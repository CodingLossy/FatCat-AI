// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 硬编码界面文案检查(ADR 0043 第 3 节)。扫描 apps/web/src 下的非测试 .tsx:
//   1. 出现中文字符(注释除外)就失败 —— 界面文字必须走 t();
//   2. JSX 文本节点或 placeholder/title/aria-label/alt 属性里出现含空格的英文短句也失败。
// 例外写在 scripts/i18n-allowlist.json:{ "文件:行内容片段": "理由" }。
// 字典一致性、占位符一致性由 packages/i18n 的单测检查。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const webSrc = join(root, 'apps/web/src');
const allow = JSON.parse(readFileSync(join(root, 'scripts/i18n-allowlist.json'), 'utf8'));

function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return walk(p);
        return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [p] : [];
    });
}

const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;
const ATTR = /\b(?:placeholder|title|aria-label|alt)=(?:"([^"{}]*)"|'([^'{}]*)')/g;
const JSX_TEXT = />([^<>{}\n]+)</g;
const SENTENCE = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/;

function stripComments(line, state) {
    let out = '';
    for (let i = 0; i < line.length; i++) {
        if (state.block) {
            const end = line.indexOf('*/', i);
            if (end < 0) return out;
            state.block = false;
            i = end + 1;
        } else if (line.startsWith('/*', i)) {
            state.block = true;
            i++;
        } else if (line.startsWith('//', i) && !/https?:$/.test(out)) {
            return out;
        } else {
            out += line[i];
        }
    }
    return out;
}

const problems = [];
const used = new Set();
for (const file of walk(webSrc)) {
    const rel = relative(root, file);
    const state = { block: false };
    readFileSync(file, 'utf8')
        .split('\n')
        .forEach((raw, idx) => {
            const line = stripComments(raw, state);
            const hits = [];
            if (CJK.test(line)) hits.push('CJK text');
            for (const m of line.matchAll(ATTR))
                if (SENTENCE.test(m[1] ?? m[2] ?? '')) hits.push(`attribute "${m[1] ?? m[2]}"`);
            for (const m of line.matchAll(JSX_TEXT)) if (SENTENCE.test(m[1])) hits.push(`JSX text "${m[1].trim()}"`);
            for (const what of hits) {
                const key = Object.keys(allow).find(
                    (k) => k.startsWith(`${rel}:`) && raw.includes(k.slice(rel.length + 1)),
                );
                if (key) used.add(key);
                else problems.push(`${rel}:${idx + 1}: hardcoded ${what}`);
            }
        });
}
for (const key of Object.keys(allow)) if (!used.has(key)) problems.push(`stale allowlist entry: ${key}`);

if (problems.length) {
    console.error(problems.join('\n'));
    console.error(
        `\ncheck:i18n failed: ${problems.length} problem(s). Move the text into packages/i18n or allowlist it.`,
    );
    process.exit(1);
}
console.log('check:i18n ok');
