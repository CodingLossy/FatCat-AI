// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PAGES, toStarlight } from './sync-docs.mjs';

test('title moves into frontmatter and the heading is removed', () => {
    const out = toStarlight('# Docker 部署: 指南\n\n正文\n\n## 小节\n', 'x');
    assert.equal(out, '---\ntitle: "Docker 部署: 指南"\n---\n\n正文\n\n## 小节\n');
});

test('falls back to the given title when there is no heading', () => {
    assert.match(toStarlight('只有正文\n', 'fallback'), /^---\ntitle: "fallback"\n---/);
});

test('every synced source file exists', () => {
    const repo = fileURLToPath(new URL('../../..', import.meta.url));
    for (const [from] of PAGES) assert.ok(existsSync(join(repo, from)), from);
});
