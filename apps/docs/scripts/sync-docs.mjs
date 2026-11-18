// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 把仓库 docs/ 里已有的指南同步进站点内容目录(单一来源:改 docs/,不改生成的副本)。
// 生成的文件在 .gitignore 里;标题取第一行 `# 标题`,并从正文去掉那一行(Starlight 用 frontmatter 的 title 渲染)。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const content = join(here, '../src/content/docs');

/** [仓库内源文件, 站点内的目标路径(相对 content)] */
export const PAGES = [
    ['docs/deploy/docker.md', 'guides/docker.md'],
    ['docs/deploy/docker.en.md', 'en/guides/docker.md'],
];

export function toStarlight(markdown, fallbackTitle) {
    const lines = markdown.replaceAll('\r\n', '\n').split('\n');
    const i = lines.findIndex((l) => /^# /.test(l));
    const title = i >= 0 ? lines[i].slice(2).trim() : fallbackTitle;
    if (i >= 0) lines.splice(i, 1);
    const body = lines.join('\n').replace(/^\n+/, '');
    return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${body}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    for (const [from, to] of PAGES) {
        const target = join(content, to);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, toStarlight(readFileSync(join(repo, from), 'utf8'), to));
    }
    console.log(`synced ${PAGES.length} page(s)`);
}
