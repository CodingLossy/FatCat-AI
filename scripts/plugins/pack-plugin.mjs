#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 把一个插件目录打成市场用的 .tgz(ADR 0040 第 5.4 节):plugin.json 在包的根目录,只用 Node 内置模块。
//
//   node scripts/plugins/pack-plugin.mjs <插件目录> [--out <文件.tgz>] [--url <发布后的下载地址>] [--core-version 1.1.0]
//
// 输出逐字节可复现:条目按路径的 UTF-8 字节序排序,mtime、uid、gid、用户名、权限位固定,gzip 头的 mtime 为 0、
// 系统字节固定为 3。只写 ustar:路径超过 100 字节时放进 prefix 字段(最多 155 字节),放不下就报错,
// 不写 pax / GNU 长名扩展。只打普通文件(不写目录条目);符号链接、junction、硬链接、特殊文件、任何层级的
// node_modules 都报错。打包后用与客户端相同的 extractTgz、validateStagedPackage 和 check-index.mjs 的
// staticScan 自检,通过才写文件。需要先构建 packages/shared 与 packages/tools(`pnpm build`)。
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { listScripts, staticScan } from './check-index.mjs';

export class PackError extends Error {}

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

/** 遍历目录,返回按 UTF-8 字节序排序的 [{ rel, abs, size }]。 */
export function collectFiles(root) {
    const files = [];
    const walk = (dir, relDir) => {
        for (const name of readdirSync(dir)) {
            const rel = relDir ? `${relDir}/${name}` : name;
            if (name === 'node_modules')
                throw new PackError(`${rel}: node_modules is not allowed; bundle your dependencies`);
            if (name.includes('\\')) throw new PackError(`${rel}: a backslash in a file name is not allowed`);
            const abs = join(dir, name);
            const stat = lstatSync(abs);
            if (stat.isSymbolicLink()) throw new PackError(`${rel}: symbolic links and junctions are not allowed`);
            if (stat.isDirectory()) walk(abs, rel);
            else if (stat.isFile()) {
                if (stat.nlink > 1) throw new PackError(`${rel}: hard links are not allowed`);
                files.push({ rel, abs, size: stat.size });
            } else throw new PackError(`${rel}: only regular files and directories are allowed`);
        }
    };
    walk(root, '');
    files.sort((a, b) => Buffer.compare(Buffer.from(a.rel, 'utf8'), Buffer.from(b.rel, 'utf8')));
    return files;
}

function splitName(rel) {
    if (Buffer.byteLength(rel) <= NAME_MAX) return { name: rel, prefix: '' };
    for (let i = 0; i < rel.length; i++) {
        if (rel[i] !== '/') continue;
        const prefix = rel.slice(0, i);
        const name = rel.slice(i + 1);
        if (Buffer.byteLength(prefix) <= PREFIX_MAX && Buffer.byteLength(name) <= NAME_MAX) return { name, prefix };
    }
    throw new PackError(
        `${rel}: the path does not fit in a ustar header (100-byte name, 155-byte prefix); use shorter names`,
    );
}

function text(value, length) {
    const out = Buffer.alloc(length);
    out.write(value, 0, 'utf8');
    return out;
}

function header(rel, size) {
    const { name, prefix } = splitName(rel);
    const block = Buffer.alloc(BLOCK);
    text(name, NAME_MAX).copy(block, 0);
    text('0000644', 8).copy(block, 100);
    text('0000000', 8).copy(block, 108);
    text('0000000', 8).copy(block, 116);
    text(size.toString(8).padStart(11, '0'), 12).copy(block, 124);
    text('00000000000', 12).copy(block, 136);
    block.fill(0x20, 148, 156);
    block[156] = 0x30;
    text('ustar', 6).copy(block, 257);
    text('00', 2).copy(block, 263);
    text(prefix, PREFIX_MAX).copy(block, 345);
    let sum = 0;
    for (const byte of block) sum += byte;
    text(`${sum.toString(8).padStart(6, '0')}\0 `, 8).copy(block, 148);
    return block;
}

/** 由 [{ rel, data }] 生成确定性的 tar。 */
export function buildTar(entries) {
    const parts = [];
    for (const { rel, data } of entries) {
        parts.push(header(rel, data.length));
        if (data.length > 0) parts.push(data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
    }
    parts.push(Buffer.alloc(BLOCK * 2));
    return Buffer.concat(parts);
}

export function buildTgz(entries) {
    const gz = gzipSync(buildTar(entries), { level: 9 });
    // 不同平台的 zlib 可能写不同的系统字节;固定为 3(Unix),mtime 字段本来就是 0
    gz[9] = 3;
    return gz;
}

/**
 * 打包并自检。`deps` 是 { extractTgz, validateStagedPackage }(与客户端同一份实现)。
 * 返回 { bytes, sha256, size, manifest, files }。
 */
export async function packPlugin({ dir, deps, coreVersion = '1.1.0' }) {
    const root = resolve(dir);
    if (!lstatSync(root).isDirectory()) throw new PackError(`${root} is not a directory`);
    const files = collectFiles(root);
    if (!files.some((f) => f.rel === 'plugin.json'))
        throw new PackError('plugin.json must be at the top of the folder');
    const bytes = buildTgz(files.map((f) => ({ rel: f.rel, data: readFileSync(f.abs) })));
    const check = mkdtempSync(join(tmpdir(), 'fatcat-pack-'));
    try {
        const target = join(check, 'pkg');
        mkdirSync(target);
        await deps.extractTgz(bytes, target);
        const { manifest } = deps.validateStagedPackage(target, coreVersion);
        const findings = staticScan(listScripts(target));
        if (findings.length > 0) throw new PackError(`static check failed:\n  ${findings.join('\n  ')}`);
        return {
            bytes,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
            manifest,
            files: files.map((f) => f.rel),
        };
    } finally {
        rmSync(check, { recursive: true, force: true });
    }
}

/** index.json 里这个版本的条目草稿;`url` 在上传文件后才知道。 */
export function draftVersionEntry({ manifest, size, sha256, url, publishedAt = new Date() }) {
    return {
        version: manifest.version,
        engines: manifest.engines,
        url,
        size,
        sha256,
        permissions: manifest.permissions,
        publishedAt: publishedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        yanked: false,
        yankedReason: null,
    };
}

async function loadDeps() {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    try {
        const market = await import(pathToFileURL(join(root, 'packages/tools/dist/plugins/market-entry.js')).href);
        return { extractTgz: market.extractTgz, validateStagedPackage: market.validateStagedPackage };
    } catch (error) {
        throw new PackError(`build the packages first (pnpm build): ${error instanceof Error ? error.message : error}`);
    }
}

function parseArgs(argv) {
    const out = { dir: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (['--out', '--url', '--core-version'].includes(arg)) {
            const value = argv[++i];
            if (value === undefined) throw new PackError(`${arg} needs a value`);
            out[arg.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
        } else if (arg.startsWith('--') || out.dir !== null) throw new PackError(`unknown argument: ${arg}`);
        else out.dir = arg;
    }
    if (out.dir === null) {
        throw new PackError(
            'usage: pack-plugin.mjs <plugin-folder> [--out file.tgz] [--url download-url] [--core-version 1.1.0]',
        );
    }
    return out;
}

export async function main(argv) {
    const args = parseArgs(argv);
    const result = await packPlugin({
        dir: args.dir,
        deps: await loadDeps(),
        ...(args.coreVersion ? { coreVersion: args.coreVersion } : {}),
    });
    const out = resolve(args.out ?? `${result.manifest.id}-${result.manifest.version}.tgz`);
    writeFileSync(out, result.bytes);
    console.log(`wrote ${out}`);
    console.log(`size ${result.size} bytes (${result.files.length} files)`);
    console.log(`sha256 ${result.sha256}`);
    console.log('\nDraft entry for the "versions" array of this plugin in index.json:');
    console.log(
        JSON.stringify(
            draftVersionEntry({
                manifest: result.manifest,
                size: result.size,
                sha256: result.sha256,
                url: args.url ?? 'https://REPLACE-WITH-THE-UPLOADED-FILE-URL',
            }),
            null,
            2,
        ),
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch((error) => {
        console.error(`error: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
    });
}
