// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// check-i18n.mjs 的反向用例:硬编码文案必须让检查失败,干净的文件必须通过(防止正则被改坏却不报错)。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-i18n.mjs', import.meta.url));

function run(source) {
    const dir = mkdtempSync(join(tmpdir(), 'check-i18n-'));
    try {
        writeFileSync(join(dir, 'Page.tsx'), source);
        return spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('clean component passes', () => {
    const r = run("export const A = () => <p title={t('a')}>{t('b')}</p>;\n// 注释里的中文不算\n");
    assert.equal(r.status, 0, r.stderr);
});

test('Chinese text fails', () => {
    const r = run('export const A = () => <p>保存</p>;\n');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CJK/);
});

test('English phrase in JSX text or attribute fails', () => {
    assert.equal(run('export const A = () => <p>Save the file</p>;\n').status, 1);
    assert.equal(run('export const A = () => <input placeholder="Type a message" />;\n').status, 1);
});
