// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// check-site 的反向用例:在临时 dist 里造好链接和坏链接,确认能分别通过和报错。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkSite } from './check-site.mjs';

function site(pages) {
    const dist = mkdtempSync(join(tmpdir(), 'check-site-'));
    const all = { 'pagefind/pagefind.js': '', ...pages };
    for (const [path, html] of Object.entries(all)) {
        const file = join(dist, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, html);
    }
    return dist;
}

const page = (...hrefs) => `<html><body>${hrefs.map((h) => `<a href="${h}">x</a>`).join('')}</body></html>`;

function problemsOf(pages) {
    const dist = site(pages);
    try {
        return checkSite(dist).problems;
    } finally {
        rmSync(dist, { recursive: true, force: true });
    }
}

const pair = (zhHtml, enHtml = page()) => ({
    'index.html': zhHtml,
    'en/index.html': enHtml,
    'faq/index.html': page(),
    'en/faq/index.html': page(),
});

test('a healthy site passes (base links, external links, anchors)', () => {
    const ok = pair(page('/FatCat-AI/faq/', 'https://example.com/x', '#top', 'faq/', 'mailto:a@b.c'));
    assert.deepEqual(problemsOf(ok), []);
});

test('a link to a missing page is reported', () => {
    assert.match(problemsOf(pair(page('/FatCat-AI/nope/')))[0], /broken link \/FatCat-AI\/nope\//);
});

test('an internal link without the base is reported', () => {
    assert.match(problemsOf(pair(page('/faq/')))[0], /without the \/FatCat-AI base: \/faq\//);
});

test('a broken relative link is reported, a good one is not', () => {
    assert.match(problemsOf(pair(page('missing/')))[0], /broken relative link missing\//);
    assert.deepEqual(problemsOf(pair(page('faq/'))), []);
});

test('a page without its twin and a missing search index are reported', () => {
    const lonely = { 'index.html': page(), 'en/index.html': page(), 'only-zh/index.html': page() };
    assert.match(problemsOf(lonely).join('\n'), /missing English page for only-zh\/index\.html/);
    const dist = site(pair(page()));
    rmSync(join(dist, 'pagefind'), { recursive: true });
    try {
        assert.match(checkSite(dist).problems.join('\n'), /search index/);
    } finally {
        rmSync(dist, { recursive: true, force: true });
    }
});
