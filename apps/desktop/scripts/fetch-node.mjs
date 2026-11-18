// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
// 下载当前平台的官方 Node 发行包,按 node-runtime.json 里固定的 SHA-256 校验(校验和不来自下载源),
// 只取出 node 可执行文件放进 apps/desktop/dist/node/。用法:node apps/desktop/scripts/fetch-node.mjs [输出目录]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeDistribution } from './release-lib.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(desktop, 'dist/node'));
const pinned = JSON.parse(readFileSync(join(desktop, 'node-runtime.json'), 'utf8'));
const dist = nodeDistribution(pinned.version, process.platform, process.arch);
const expected = pinned.sha256[dist.target];
if (!expected) throw new Error(`no pinned Node checksum for ${dist.target}`);

const work = mkdtempSync(join(tmpdir(), 'fatcat-node-'));
try {
    const res = await fetch(dist.url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${dist.url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error(`checksum mismatch for ${dist.file}: expected ${expected}, got ${actual}`);
    const archive = join(work, dist.file);
    writeFileSync(archive, bytes);
    // tar 在三个平台的 runner 上都能解 tar.gz / tar.xz / zip(Windows 自带 bsdtar)。
    execFileSync('tar', ['-xf', archive, '-C', work, dist.inner], { stdio: 'inherit' });
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const target = join(out, dist.exe);
    copyFileSync(join(work, dist.inner), target);
    if (process.platform !== 'win32') chmodSync(target, 0o755);
    if (!existsSync(target)) throw new Error('node executable missing after extraction');
    console.log(`node ${pinned.version} (${dist.target}) staged at ${target}`);
} finally {
    rmSync(work, { recursive: true, force: true });
}
