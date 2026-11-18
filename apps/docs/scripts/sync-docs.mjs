// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 把仓库 docs/ 里已有的指南同步进站点内容目录(单一来源:改 docs/,不改生成的副本)。
// 生成的文件在 .gitignore 里;标题取第一行 `# 标题`,并从正文去掉那一行(Starlight 用 frontmatter 的 title 渲染)。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const content = join(here, '../src/content/docs');

const GITHUB = 'https://github.com/CodingLossy/FatCat-AI/blob/main';
const BASE = '/FatCat-AI';

/** [仓库内源文件, 站点内的目标路径(相对 content)] */
export const PAGES = [
    ['docs/deploy/docker.md', 'guides/docker.md'],
    ['docs/deploy/docker.en.md', 'en/guides/docker.md'],
    ['docs/deploy/desktop.md', 'guides/desktop.md'],
    ['docs/deploy/desktop.en.md', 'en/guides/desktop.md'],
    ['docs/plugins/developing-plugins.zh-CN.md', 'guides/plugins.md'],
    ['docs/plugins/developing-plugins.md', 'en/guides/plugins.md'],
];

/** 站点内的页面地址,如 guides/docker.md → /FatCat-AI/guides/docker/ */
const siteUrl = (target) => `${BASE}/${target.replace(/\.md$/, '')}/`;

/**
 * 把源文件里的相对链接改成站点页面(如果那个文件也被同步进站点)或 GitHub 上的文件地址。
 * 代码块里的内容不动;http、锚点和绝对路径不动。
 */
export function rewriteLinks(markdown, sourcePath) {
    const synced = new Map(PAGES.map(([from, to]) => [from, to]));
    let fenced = false;
    return markdown
        .split('\n')
        .map((line) => {
            if (/^\s*```/.test(line)) fenced = !fenced;
            if (fenced) return line;
            return line.replace(/\]\((?!https?:|#|\/|mailto:)([^)\s]+)\)/g, (_m, href) => {
                const [path, hash = ''] = href.split(/(?=#)/);
                const resolved = posix.normalize(posix.join(posix.dirname(sourcePath), path));
                if (resolved.startsWith('..')) return `](${href})`;
                const target = synced.get(resolved);
                return target ? `](${siteUrl(target)}${hash})` : `](${GITHUB}/${resolved}${hash})`;
            });
        })
        .join('\n');
}

function frontmatter(title) {
    return `---\ntitle: ${JSON.stringify(title)}\neditUrl: false\n---\n\n`;
}

export function toStarlight(markdown, fallbackTitle, sourcePath = '') {
    const lines = markdown.replaceAll('\r\n', '\n').split('\n');
    const i = lines.findIndex((l) => /^# /.test(l));
    const title = i >= 0 ? lines[i].slice(2).trim() : fallbackTitle;
    if (i >= 0) lines.splice(i, 1);
    const body = lines.join('\n').replace(/^\n+/, '');
    return frontmatter(title) + (sourcePath ? rewriteLinks(body, sourcePath) : body);
}

/** ADR 汇总:编号、标题(链到 GitHub)、状态(取「- 状态:」那一行的开头)。 */
export function adrIndex(files, read, lang) {
    const rows = files
        .filter((f) => /^\d{4}-.*\.md$/.test(f))
        .sort()
        .map((f) => {
            const text = read(f);
            const heading = /^# (.+)$/m.exec(text)?.[1] ?? f;
            const title = heading.replace(/^ADR\s+\d+\s*[·:：-]\s*/, '').trim();
            const status = /^- 状态[::]\s*(.+)$/m.exec(text)?.[1] ?? '';
            const short = status.replace(/[*`]/g, '').split(/[(（]/)[0].trim().slice(0, 40);
            return `| ${f.slice(0, 4)} | [${title.replaceAll('|', '\\|')}](${GITHUB}/docs/adr/${f}) | ${short} |`;
        });
    const intro =
        lang === 'en'
            ? 'Architecture decision records. They are written in Chinese; each row links to the source on GitHub.'
            : '架构决策记录(ADR)。每一行链到 GitHub 上的原文。';
    const head = lang === 'en' ? '| No. | Title | Status |' : '| 编号 | 标题 | 状态 |';
    return `${frontmatter(lang === 'en' ? 'Architecture decisions' : '设计决策(ADR)')}${intro}\n\n${head}\n| --- | --- | --- |\n${rows.join('\n')}\n`;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** API 参考:按第一个 tag 分组,列出方法、路径和摘要(摘要是英文,与 OpenAPI 文档一致)。 */
export function apiReference(spec, lang) {
    const groups = new Map();
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
        for (const method of METHODS) {
            const op = item[method];
            if (!op) continue;
            const tag = op.tags?.[0] ?? 'other';
            if (!groups.has(tag)) groups.set(tag, []);
            groups
                .get(tag)
                .push(`| \`${method.toUpperCase()}\` | \`${path}\` | ${(op.summary ?? '').replaceAll('|', '\\|')} |`);
        }
    }
    const zh = lang !== 'en';
    const intro = zh
        ? '所有能力都通过版本化的 `/api/v1` HTTP + WebSocket 接口提供,网页、命令行和渠道都只是它的客户端。完整的 OpenAPI 文档在运行中的服务器的 `/api/v1/openapi.json`(需要登录),仓库里的副本是 [`apps/server/openapi/v1.json`](' +
          GITHUB +
          '/apps/server/openapi/v1.json)。认证、错误格式和示例见快速开始里的 curl 流程。下表由该文件生成,摘要为英文。'
        : 'Everything is exposed through the versioned `/api/v1` HTTP + WebSocket API; the Web UI, CLI and channels are all clients of it. The full OpenAPI document is served at `/api/v1/openapi.json` by a running server (authentication required); the repository copy is [`apps/server/openapi/v1.json`](' +
          GITHUB +
          '/apps/server/openapi/v1.json). This table is generated from it.';
    const sections = [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
            ([tag, rows]) =>
                `## ${tag}\n\n| ${zh ? '方法' : 'Method'} | ${zh ? '路径' : 'Path'} | ${zh ? '说明' : 'Summary'} |\n| --- | --- | --- |\n${rows.join('\n')}\n`,
        );
    return `${frontmatter(zh ? 'API 参考' : 'API reference')}${intro}\n\n${sections.join('\n')}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const write = (to, text) => {
        const target = join(content, to);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
    };
    for (const [from, to] of PAGES) write(to, toStarlight(readFileSync(join(repo, from), 'utf8'), to, from));
    // 更新日志:同一份英文正文(含中文摘要)放进两种语言
    const changelog = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8');
    write(
        'changelog.md',
        toStarlight(changelog, '更新日志', 'CHANGELOG.md').replace(/^---\ntitle: ".*"/, '---\ntitle: "更新日志"'),
    );
    write(
        'en/changelog.md',
        toStarlight(changelog, 'Changelog', 'CHANGELOG.md').replace(/^---\ntitle: ".*"/, '---\ntitle: "Changelog"'),
    );
    const adrDir = join(repo, 'docs/adr');
    const adrFiles = readdirSync(adrDir);
    const readAdr = (f) => readFileSync(join(adrDir, f), 'utf8');
    write('reference/adr.md', adrIndex(adrFiles, readAdr, 'zh'));
    write('en/reference/adr.md', adrIndex(adrFiles, readAdr, 'en'));
    const spec = JSON.parse(readFileSync(join(repo, 'apps/server/openapi/v1.json'), 'utf8'));
    write('reference/api.md', apiReference(spec, 'zh'));
    write('en/reference/api.md', apiReference(spec, 'en'));
    console.log('synced docs pages');
}
