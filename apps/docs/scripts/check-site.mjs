// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 构建后检查(M9 验收「搜索可用」):每个页面的站内链接都能找到目标文件,中英文页面一一对应,Pagefind 索引存在。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '../dist');
const BASE = '/FatCat-AI';
const problems = [];

if (!existsSync(dist)) {
    console.error('dist/ not found: run the build first');
    process.exit(1);
}

function walk(dir) {
    return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

const pages = walk(dist).filter((f) => f.endsWith('.html') && !f.endsWith('404.html'));
for (const file of pages) {
    const html = readFileSync(file, 'utf8');
    for (const m of html.matchAll(/href="([^"#?]+)[^"]*"/g)) {
        const href = m[1];
        if (!href.startsWith(`${BASE}/`) || /\.(css|js|svg|png|ico|xml|webmanifest)$/.test(href)) continue;
        const target = join(dist, href.slice(BASE.length));
        if (!existsSync(join(target, 'index.html')) && !existsSync(target)) {
            problems.push(`${relative(dist, file)}: broken link ${href}`);
        }
    }
}

// 中文页面(根)与英文页面(/en/)一一对应
const rel = pages.map((f) => relative(dist, f).replaceAll('\\', '/'));
const zh = new Set(rel.filter((p) => !p.startsWith('en/')));
const en = new Set(rel.filter((p) => p.startsWith('en/')).map((p) => p.slice(3)));
for (const p of zh) if (!en.has(p)) problems.push(`missing English page for ${p}`);
for (const p of en) if (!zh.has(p)) problems.push(`missing Chinese page for en/${p}`);

if (!existsSync(join(dist, 'pagefind/pagefind.js'))) problems.push('search index (pagefind) missing');

if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log(`check-site ok: ${pages.length} pages, search index present`);
