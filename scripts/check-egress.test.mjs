// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// check-egress.mjs 的自测:在临时夹具目录里造一份迷你仓库,不扫真实仓库。
// 运行:node --test scripts/check-egress.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { checkEgress } from './check-egress.mjs';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** files: 相对路径 → 内容;registry: 登记表。 */
function fixture(files, registry) {
    const root = mkdtempSync(join(tmpdir(), 'egress-'));
    dirs.push(root);
    const all = { ...files, 'scripts/egress-registry.json': JSON.stringify(registry) };
    for (const [path, text] of Object.entries(all)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
    }
    return root;
}

const EGRESS = 'export function modelTargets() { return []; }\n';
const CALLER = "export const get = () => fetch('https://example.com');\n";
const entry = { file: 'packages/p/src/http.ts', kind: 'fixed', listedAs: 'modelTargets', reason: 'model calls' };

test('an unregistered network call site fails', () => {
    const root = fixture({ 'apps/server/src/egress.ts': EGRESS, 'packages/p/src/http.ts': CALLER }, []);
    const errors = checkEgress(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /http\.ts: uses a network API but is not in the egress registry/);
});

test('a registry entry without a network call in the code fails', () => {
    const root = fixture({ 'apps/server/src/egress.ts': EGRESS, 'packages/p/src/http.ts': 'export const x = 1;\n' }, [
        entry,
    ]);
    const errors = checkEgress(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /registered, but no network API is used/);
});

test('a fixed entry whose listedAs is not a symbol of egress.ts fails', () => {
    const root = fixture({ 'apps/server/src/egress.ts': EGRESS, 'packages/p/src/http.ts': CALLER }, [
        { ...entry, listedAs: 'missingTargets' },
    ]);
    const errors = checkEgress(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /listedAs "missingTargets" is not defined/);
});

test('everything registered passes; tests, comments and non-production dirs are not scanned', () => {
    const root = fixture(
        {
            'apps/server/src/egress.ts': EGRESS,
            'packages/p/src/http.ts': CALLER,
            'packages/p/src/http.test.ts': CALLER,
            'packages/p/src/note.ts': '// fetch( is only mentioned in a comment\nexport const y = 2;\n',
            'packages/p/e2e/run.ts': CALLER,
            'scripts/tool.mjs': CALLER,
        },
        [entry],
    );
    assert.deepEqual(checkEgress(root), []);
});
