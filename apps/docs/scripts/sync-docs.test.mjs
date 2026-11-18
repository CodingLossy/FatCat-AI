// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adrIndex, apiReference, PAGES, rewriteLinks, toStarlight } from './sync-docs.mjs';

test('title moves into frontmatter and the heading is removed', () => {
    const out = toStarlight('# Docker 部署: 指南\n\n正文\n\n## 小节\n', 'x');
    assert.equal(out, '---\ntitle: "Docker 部署: 指南"\neditUrl: false\n---\n\n正文\n\n## 小节\n');
});

test('falls back to the given title when there is no heading', () => {
    assert.match(toStarlight('只有正文\n', 'fallback'), /^---\ntitle: "fallback"\neditUrl: false\n---/);
});

test('every synced source file exists', () => {
    const repo = fileURLToPath(new URL('../../..', import.meta.url));
    for (const [from] of PAGES) assert.ok(existsSync(join(repo, from)), from);
});

test('relative links become site pages or GitHub files; code and absolute links stay', () => {
    const md = [
        '[en](docker.en.md#top) [adr](../adr/0040-x.md) [dir](../../examples/plugins/hello) [web](https://a.b/c)',
        '```',
        '[no](rewrite.md)',
        '```',
    ].join('\n');
    const out = rewriteLinks(md, 'docs/deploy/docker.md');
    assert.match(out, /\[en\]\(\/FatCat-AI\/en\/guides\/docker\/#top\)/);
    assert.match(out, /\(https:\/\/github\.com\/CodingLossy\/FatCat-AI\/blob\/main\/docs\/adr\/0040-x\.md\)/);
    assert.match(out, /blob\/main\/examples\/plugins\/hello\)/);
    assert.match(out, /\(https:\/\/a\.b\/c\)/);
    assert.match(out, /\[no\]\(rewrite\.md\)/);
});

test('ADR index lists number, title and a short status', () => {
    const files = ['0001-a.md', 'notes.txt', '0002-b.md'];
    const text = {
        '0001-a.md': '# ADR 0001 · 技术栈\n\n- 状态:已采纳\n',
        '0002-b.md': '# ADR 0002 · 许可证\n\n- 状态:**提议**(待审阅)\n',
    };
    const out = adrIndex(files, (f) => text[f], 'zh');
    assert.match(out, /\| 0001 \| \[技术栈\]\(.*0001-a\.md\) \| 已采纳 \|/);
    assert.match(out, /\| 0002 \| \[许可证\]\(.*0002-b\.md\) \| 提议 \|/);
    assert.ok(!out.includes('notes.txt'));
});

test('API reference groups operations by tag', () => {
    const spec = {
        paths: {
            '/api/v1/a': { get: { tags: ['x'], summary: 'List | a' }, post: { tags: ['x'], summary: 'Make a' } },
            '/api/v1/b': { delete: { tags: ['y'], summary: 'Drop b' } },
        },
    };
    const out = apiReference(spec, 'en');
    assert.match(out, /## x[\s\S]*`GET` \| `\/api\/v1\/a` \| List \\\| a/);
    assert.match(out, /## y[\s\S]*`DELETE`/);
});
