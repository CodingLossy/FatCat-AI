// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 运行:node --test scripts/check-workflow-secrets.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWorkflowSecrets, findPrivateKeySecretRefs } from './check-workflow-secrets.mjs';

test('flags private key secret references in any spelling', () => {
    const text = [
        'env:',
        '  KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}',
        "  OTHER: ${{ secrets['DEPLOY_PRIVATE_KEY'] }}",
        '  FOO: ${{ secrets.signing_private_key_pw }}',
    ].join('\n');
    assert.deepEqual(
        findPrivateKeySecretRefs(text).map((h) => h.line),
        [2, 3, 4],
    );
});

test('allows ordinary secrets and comments', () => {
    const text = ['# never use secrets.X_PRIVATE_KEY here', 'token: ${{ secrets.GITHUB_TOKEN }}'].join('\n');
    assert.deepEqual(findPrivateKeySecretRefs(text), []);
});

test('the repository workflows are clean', () => {
    assert.deepEqual(checkWorkflowSecrets(new URL('..', import.meta.url).pathname), []);
});
