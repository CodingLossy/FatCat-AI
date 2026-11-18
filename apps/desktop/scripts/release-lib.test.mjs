// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkInstallerSizes, MAX_INSTALLER_BYTES, nodeDistribution, sha256Sums } from './release-lib.mjs';

test('installer size check fails over the limit, ignores non-installers, and fails when nothing is found', () => {
    const ok = checkInstallerSizes([
        { name: 'FatCat-AI_0.0.0_amd64.deb', size: 60 * 1048576 },
        { name: 'notes.txt', size: 500 * 1048576 },
    ]);
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.installers.length, 1);
    const big = checkInstallerSizes([{ name: 'FatCat-AI.AppImage', size: MAX_INSTALLER_BYTES + 1 }]);
    assert.equal(big.errors.length, 1);
    assert.match(big.errors[0], /exceeds 80 MB/);
    assert.deepEqual(checkInstallerSizes([{ name: 'readme.md', size: 1 }]).errors, ['no installer found']);
});

test('sha256Sums matches the sha256sum format and is sorted', () => {
    const text = sha256Sums([
        { name: 'b.deb', bytes: Buffer.from('b') },
        { name: 'a.msi', bytes: Buffer.from('abc') },
    ]);
    assert.equal(
        text,
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  a.msi\n' +
            '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  b.deb\n',
    );
});

test('nodeDistribution maps platforms to the official file names', () => {
    assert.equal(nodeDistribution('24.11.0', 'linux', 'x64').file, 'node-v24.11.0-linux-x64.tar.xz');
    assert.equal(nodeDistribution('24.11.0', 'darwin', 'arm64').inner, 'node-v24.11.0-darwin-arm64/bin/node');
    const win = nodeDistribution('24.11.0', 'win32', 'x64');
    assert.equal(win.file, 'node-v24.11.0-win-x64.zip');
    assert.equal(win.inner, 'node-v24.11.0-win-x64/node.exe');
    assert.equal(win.exe, 'node.exe');
});
