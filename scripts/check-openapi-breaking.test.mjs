// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 自测:CI 的 oasdiff 比较(.github/workflows/ci.yml 的 openapi-compat)真的会拦住破坏性变更。
// 用仓库里的 apps/server/openapi/v1.json 作基线,在临时目录里造几份改过的文档,用与 CI 相同的参数运行 oasdiff。
// 默认通过 docker 运行 tufin/oasdiff(与 CI 同一镜像);设置 OASDIFF_BIN 可改用本地二进制(同一版本)。
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const IMAGE = 'tufin/oasdiff:v1.35.0';
const root = fileURLToPath(new URL('..', import.meta.url));
const basePath = join(root, 'apps/server/openapi/v1.json');
const bin = process.env.OASDIFF_BIN;

const available = bin
    ? spawnSync(bin, ['--version']).status === 0
    : spawnSync('docker', ['version', '--format', '{{.Server.Version}}']).status === 0;

/** 返回 oasdiff 的结果:退出码 0 = 通过,1 = 有破坏性变更;参数或文件出错时是其他非 0 值(见 expectBreaking)。 */
function diff(mutate) {
    const dir = mkdtempSync(join(tmpdir(), 'oasdiff-'));
    const doc = JSON.parse(readFileSync(basePath, 'utf8'));
    mutate(doc);
    copyFileSync(basePath, join(dir, 'base.json'));
    writeFileSync(join(dir, 'head.json'), JSON.stringify(doc));
    copyFileSync(join(root, '.github/oasdiff-severity.txt'), join(dir, 'severity.txt'));
    // 与 CI 一致:例外清单必须为空,所以这里用一个空文件
    writeFileSync(join(dir, 'err-ignore.txt'), '');
    const args = [
        'breaking',
        bin ? join(dir, 'base.json') : '/specs/base.json',
        bin ? join(dir, 'head.json') : '/specs/head.json',
        '--fail-on',
        'ERR',
        '--severity-levels',
        bin ? join(dir, 'severity.txt') : '/specs/severity.txt',
        '--err-ignore',
        bin ? join(dir, 'err-ignore.txt') : '/specs/err-ignore.txt',
    ];
    const r = bin
        ? spawnSync(bin, args, { encoding: 'utf8' })
        : spawnSync('docker', ['run', '--rm', '-v', `${dir}:/specs:ro`, IMAGE, ...args], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

function expectStatus(r, expected) {
    assert.equal(r.status, expected, `oasdiff exited ${r.status}\n${r.stdout}\n${r.stderr}`);
}

// 在 CI 里不允许跳过:没有 docker 也没有 OASDIFF_BIN 等于自测没做
if (process.env.CI && !available) throw new Error('oasdiff is unavailable in CI: the self-test cannot be skipped');

const opts = { skip: available ? false : 'neither docker nor OASDIFF_BIN is available' };

test('the committed document diffed against itself passes', opts, () => {
    expectStatus(
        diff(() => undefined),
        0,
    );
});

test('removing a required response property fails', opts, () => {
    expectStatus(
        diff((doc) => {
            const schema = doc.paths['/api/v1/meta'].get.responses['200'].content['application/json'].schema;
            delete schema.properties.serverVersion;
            schema.required = schema.required.filter((k) => k !== 'serverVersion');
        }),
        1,
    );
});

test('removing an operation fails', opts, () => {
    expectStatus(
        diff((doc) => {
            delete doc.paths['/api/v1/auth/status'];
        }),
        1,
    );
});

test('adding a new endpoint passes (backwards-compatible increment)', opts, () => {
    expectStatus(
        diff((doc) => {
            doc.paths['/api/v1/zz-selftest'] = {
                get: { responses: { 200: { description: 'ok' } } },
            };
        }),
        0,
    );
});
