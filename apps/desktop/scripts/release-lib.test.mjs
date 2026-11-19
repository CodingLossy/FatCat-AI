// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    checkDesktopVersion,
    checkInstallerSizes,
    MAX_APPIMAGE_BYTES,
    MAX_INSTALLER_BYTES,
    nodeDistribution,
    parsePsJson,
    processState,
    sha256Sums,
} from './release-lib.mjs';

test('a process that Get-Process cannot find counts as exited; a live one reports its name and pid', () => {
    // 进程已退出:SilentlyContinue 下没有任何输出(退出码可能非零,不参与判断)。
    assert.deepEqual(processState(''), { alive: false });
    assert.deepEqual(processState('\r\n'), { alive: false });
    assert.deepEqual(processState(undefined), { alive: false });
    assert.deepEqual(processState('{"Id":10236,"ProcessName":"node"}'), {
        alive: true,
        pid: 10236,
        name: 'node',
    });
    assert.deepEqual(parsePsJson('[{"ProcessId":1},{"ProcessId":2}]'), [{ ProcessId: 1 }, { ProcessId: 2 }]);
    // 非空但不是 JSON 说明脚本真的出错了,不能当成「已退出」。
    assert.throws(() => processState('Get-Process : something broke'));
});

test('installer size check fails over the limit, ignores non-installers, and fails when nothing is found', () => {
    const ok = checkInstallerSizes([
        { name: 'FatCat-AI_0.0.0_amd64.deb', size: 60 * 1048576 },
        { name: 'notes.txt', size: 500 * 1048576 },
    ]);
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.installers.length, 1);
    const big = checkInstallerSizes([{ name: 'FatCat-AI.deb', size: MAX_INSTALLER_BYTES + 1 }]);
    assert.equal(big.errors.length, 1);
    assert.match(big.errors[0], /exceeds 80 MB/);
    // AppImage 有自己的上限,其他格式不受影响。
    const image = { name: 'appimage/FatCat-AI.AppImage', size: MAX_INSTALLER_BYTES + 1 };
    assert.deepEqual(checkInstallerSizes([image]).errors, []);
    assert.match(checkInstallerSizes([{ ...image, size: MAX_APPIMAGE_BYTES + 1 }]).errors[0], /exceeds 140 MB/);
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

test('nodeDistribution rejects versions that could change the download target', () => {
    assert.throws(() => nodeDistribution('24.11.0/../../x', 'linux', 'x64'), /invalid Node version/);
    assert.throws(() => nodeDistribution('24.11.0', 'linux', 'x64; rm'), /unsupported/);
});

test('nodeDistribution maps platforms to the official file names', () => {
    assert.equal(nodeDistribution('24.11.0', 'linux', 'x64').file, 'node-v24.11.0-linux-x64.tar.xz');
    assert.equal(nodeDistribution('24.11.0', 'darwin', 'arm64').inner, 'node-v24.11.0-darwin-arm64/bin/node');
    const win = nodeDistribution('24.11.0', 'win32', 'x64');
    assert.equal(win.file, 'node-v24.11.0-win-x64.zip');
    assert.equal(win.inner, 'node-v24.11.0-win-x64/node.exe');
    assert.equal(win.exe, 'node.exe');
});

test('checkDesktopVersion passes when package, Cargo and tag agree', () => {
    assert.deepEqual(
        checkDesktopVersion({ packageVersion: '1.0.0', cargoVersion: '1.0.0', tag: 'desktop-v1.0.0' }),
        [],
    );
    assert.deepEqual(checkDesktopVersion({ packageVersion: '0.0.0', cargoVersion: '0.0.0' }), []);
});

test('checkDesktopVersion fails on a tag or Cargo version that differs from package.json', () => {
    const tagged = checkDesktopVersion({ packageVersion: '0.0.0', cargoVersion: '0.0.0', tag: 'desktop-v1.0.0' });
    assert.match(tagged[0], /does not match package.json version 0\.0\.0/);
    assert.match(checkDesktopVersion({ packageVersion: '1.0.0', cargoVersion: '0.0.0' })[0], /Cargo.toml version/);
    assert.match(
        checkDesktopVersion({ packageVersion: '1.0.0', cargoVersion: '1.0.0', tag: 'v1.0.0' })[0],
        /not desktop-vX/,
    );
});
