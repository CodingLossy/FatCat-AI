// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 构建后检查(M9 验收「搜索可用」):每个页面的站内链接都能找到目标文件,中英文页面一一对应,Pagefind 索引存在。
// 站内链接 = 以 /FatCat-AI/ 开头的、漏了 base 的以 / 开头的、以及相对路径;外部链接(http、mailto)不查。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = '/FatCat-AI';
const ASSET = /\.(css|js|svg|png|ico|xml|webmanifest|json|txt|wasm)$/;

function walk(dir) {
    return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

/** 返回问题列表(空 = 通过)。 */
export function checkSite(dist) {
    const problems = [];
    const exists = (urlPath) => {
        const target = join(dist, urlPath);
        return existsSync(join(target, 'index.html')) || (existsSync(target) && statSync(target).isFile());
    };
    const pages = walk(dist).filter((f) => f.endsWith('.html') && !f.endsWith('404.html'));
    for (const file of pages) {
        const rel = relative(dist, file).replaceAll('\\', '/');
        const pageUrl = `${BASE}/${rel.replace(/index\.html$/, '')}`;
        const html = readFileSync(file, 'utf8');
        for (const m of html.matchAll(/<a\s[^>]*?href="([^"#?]*)[^"]*"/g)) {
            const href = m[1];
            if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
            if (ASSET.test(href)) continue;
            if (href.startsWith('/')) {
                if (!href.startsWith(`${BASE}/`)) {
                    problems.push(`${rel}: link without the ${BASE} base: ${href}`);
                } else if (!exists(href.slice(BASE.length))) {
                    problems.push(`${rel}: broken link ${href}`);
                }
            } else {
                const resolved = posix.normalize(posix.join(pageUrl, href));
                if (!resolved.startsWith(`${BASE}/`) || !exists(resolved.slice(BASE.length))) {
                    problems.push(`${rel}: broken relative link ${href}`);
                }
            }
        }
    }

    // 中文页面(根)与英文页面(/en/)一一对应
    const rels = pages.map((f) => relative(dist, f).replaceAll('\\', '/'));
    const zh = new Set(rels.filter((p) => !p.startsWith('en/')));
    const en = new Set(rels.filter((p) => p.startsWith('en/')).map((p) => p.slice(3)));
    for (const p of zh) if (!en.has(p)) problems.push(`missing English page for ${p}`);
    for (const p of en) if (!zh.has(p)) problems.push(`missing Chinese page for en/${p}`);

    if (!existsSync(join(dist, 'pagefind/pagefind.js'))) problems.push('search index (pagefind) missing');
    return { problems, pages: pages.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const dist = join(dirname(fileURLToPath(import.meta.url)), '../dist');
    if (!existsSync(dist)) {
        console.error('dist/ not found: run the build first');
        process.exit(1);
    }
    const { problems, pages } = checkSite(dist);
    if (problems.length) {
        console.error(problems.join('\n'));
        process.exit(1);
    }
    console.log(`check-site ok: ${pages} pages, search index present`);
}
