// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 最小 tar 读取器与 .tgz 解包(ADR 0040 第 5.4 节)。只接受普通文件与目录条目;符号链接、硬链接、设备文件、
// 绝对路径、`..`、重复路径(含仅大小写不同)、Windows 盘符与保留名、超长路径一律整体拒绝;
// 解压后总大小、文件数、单文件大小有上限,压缩比超过 100 倍立即中止(边解边算,不等全部解完)。
// 解包过程不运行包里的任何代码。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';
import { badPackagePath, PACKAGE_LIMITS, PluginPackageError } from './package.js';

export const MAX_COMPRESSION_RATIO = 100;
const BLOCK = 512;
/** pax 扩展头的数据上限;超过就当作异常包。 */
const PAX_MAX_BYTES = 16 * 1024;

export interface TarLimits {
    totalBytes: number;
    files: number;
    fileBytes: number;
    ratio: number;
}

export const TAR_LIMITS: TarLimits = {
    totalBytes: PACKAGE_LIMITS.totalBytes,
    files: PACKAGE_LIMITS.files,
    fileBytes: PACKAGE_LIMITS.fileBytes,
    ratio: MAX_COMPRESSION_RATIO,
};

const invalid = (message: string) => new PluginPackageError('plugin_package_invalid', message);

function cString(buffer: Buffer, start: number, length: number): string {
    const slice = buffer.subarray(start, start + length);
    const end = slice.indexOf(0);
    return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/** 八进制数字段(空格或 NUL 结尾);高位为 1 的 base-256 写法不接受。 */
function octal(buffer: Buffer, start: number, length: number, what: string): number {
    if (((buffer[start] ?? 0) & 0x80) !== 0) throw invalid(`tar ${what} uses an unsupported encoding`);
    const text = cString(buffer, start, length).trim();
    if (text === '') return 0;
    if (!/^[0-7]+$/.test(text)) throw invalid(`tar ${what} is not a number`);
    const value = parseInt(text, 8);
    if (!Number.isSafeInteger(value)) throw invalid(`tar ${what} is too large`);
    return value;
}

function checksumOk(header: Buffer): boolean {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
    return sum === octal(header, 148, 8, 'checksum');
}

/** pax 扩展头里出现 path / linkpath / size 一律拒绝(会改变条目的名字或大小);其他键(时间戳等)忽略。 */
function checkPax(data: Buffer): void {
    let pos = 0;
    while (pos < data.length) {
        const space = data.indexOf(0x20, pos);
        if (space === -1) throw invalid('tar pax header is malformed');
        const length = Number(data.subarray(pos, space).toString('ascii'));
        if (!Number.isInteger(length) || length <= space - pos + 1 || pos + length > data.length) {
            throw invalid('tar pax header is malformed');
        }
        const record = data.subarray(space + 1, pos + length - 1).toString('utf8');
        const key = record.split('=')[0] ?? '';
        if (key === 'path' || key === 'linkpath' || key === 'size') {
            throw invalid(`tar pax header overrides "${key}", which is not supported`);
        }
        pos += length;
    }
}

type State =
    | { kind: 'header' }
    | { kind: 'file'; rel: string; size: number; chunks: Buffer[]; got: number }
    | { kind: 'pax'; size: number; chunks: Buffer[]; got: number }
    | { kind: 'skip'; left: number }
    | { kind: 'end' };

class TarExtractor {
    private buf: Buffer = Buffer.alloc(0);
    private state: State = { kind: 'header' };
    private pad = 0;
    private readonly seen = new Set<string>();
    private readonly fileKeys = new Set<string>();
    private readonly dirKeys = new Set<string>();
    files = 0;
    bytes = 0;
    private root: string;

    constructor(
        private readonly dest: string,
        private readonly limits: TarLimits,
    ) {
        this.root = resolve(dest);
        mkdirSync(this.root, { recursive: true });
    }

    get finished(): boolean {
        return this.state.kind === 'end' || (this.state.kind === 'header' && this.buf.length === 0 && this.pad === 0);
    }

    push(chunk: Buffer): void {
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        for (;;) {
            if (this.pad > 0) {
                const take = Math.min(this.pad, this.buf.length);
                this.buf = this.buf.subarray(take);
                this.pad -= take;
                if (this.pad > 0) return;
            }
            const state = this.state;
            if (state.kind === 'end') {
                // 结束标记之后只能是零
                if (this.buf.some((byte) => byte !== 0)) throw invalid('tar has data after the end marker');
                this.buf = Buffer.alloc(0);
                return;
            }
            if (state.kind === 'skip') {
                const take = Math.min(state.left, this.buf.length);
                this.buf = this.buf.subarray(take);
                state.left -= take;
                if (state.left > 0) return;
                this.state = { kind: 'header' };
                continue;
            }
            if (state.kind === 'file' || state.kind === 'pax') {
                const take = Math.min(state.size - state.got, this.buf.length);
                if (take > 0) {
                    state.chunks.push(this.buf.subarray(0, take));
                    state.got += take;
                    this.buf = this.buf.subarray(take);
                }
                if (state.got < state.size) return;
                const data = Buffer.concat(state.chunks);
                if (state.kind === 'pax') checkPax(data);
                else this.writeFile(state.rel, data);
                this.pad = (BLOCK - (state.size % BLOCK)) % BLOCK;
                this.state = { kind: 'header' };
                continue;
            }
            if (this.buf.length < BLOCK) return;
            const header = this.buf.subarray(0, BLOCK);
            this.buf = this.buf.subarray(BLOCK);
            if (header.every((byte) => byte === 0)) {
                this.state = { kind: 'end' };
                continue;
            }
            this.header(header);
        }
    }

    private header(header: Buffer): void {
        if (!checksumOk(header)) throw invalid('tar header checksum does not match');
        const magic = header.subarray(257, 262).toString('latin1');
        if (magic !== 'ustar') throw invalid('only ustar archives are supported');
        const type = String.fromCharCode(header[156] ?? 0);
        const size = octal(header, 124, 12, 'size');
        if (type === 'x' || type === 'g') {
            if (size > PAX_MAX_BYTES) throw invalid('tar pax header is too large');
            this.state = size === 0 ? { kind: 'header' } : { kind: 'pax', size, chunks: [], got: 0 };
            return;
        }
        const prefix = cString(header, 345, 155);
        const name = cString(header, 0, 100);
        let rel = prefix === '' ? name : `${prefix}/${name}`;
        if (type === '5') {
            if (size !== 0) throw invalid(`${rel}: a directory entry has data`);
            rel = rel.replace(/\/+$/, '');
            this.directory(rel);
            return;
        }
        if (type !== '0' && type !== '\0') {
            const what: Record<string, string> = {
                '1': 'hard link',
                '2': 'symbolic link',
                '3': 'character device',
                '4': 'block device',
                '6': 'FIFO',
                L: 'GNU long name',
                K: 'GNU long link name',
            };
            throw invalid(`${rel}: ${what[type] ?? `entry type "${type}"`} is not allowed`);
        }
        if (rel.endsWith('/')) throw invalid(`${rel}: a file entry ends with a slash`);
        this.register(rel, false);
        if (size > this.limits.fileBytes) throw invalid(`${rel}: file is too large`);
        this.files += 1;
        this.bytes += size;
        if (this.files > this.limits.files || this.bytes > this.limits.totalBytes) {
            throw invalid('the package has too many or too large files');
        }
        const cleaned = this.clean(rel);
        this.state = size === 0 ? { kind: 'header' } : { kind: 'file', rel: cleaned, size, chunks: [], got: 0 };
        if (size === 0) this.writeFile(cleaned, Buffer.alloc(0));
    }

    private clean(rel: string): string {
        return rel.replace(/^(\.\/)+/, '');
    }

    /** 检查路径并登记;返回规范化后的相对路径('' 表示包根目录本身)。 */
    private register(rawRel: string, isDir: boolean): string {
        const rel = this.clean(rawRel);
        if (rel === '' || rel === '.') {
            if (!isDir) throw invalid(`${rawRel}: not a valid file path`);
            return '';
        }
        const problem = badPackagePath(rel);
        if (problem) throw invalid(`${rel}: ${problem}`);
        // 空路径段(`a//b`)与 `a/b` 指向同一处,统一当作非法路径;目录条目允许一个结尾的 `/`
        if ((rel.endsWith('/') ? rel.slice(0, -1) : rel).split('/').includes('')) {
            throw invalid(`${rel}: empty path segment`);
        }
        // 判重用 NFC 规范化后的小写:`café` 的 NFC 与 NFD 两种写法在 Linux 上是两个文件,但对用户是同一个名字
        const key = rel.normalize('NFC').toLowerCase();
        if (this.seen.has(key)) throw invalid(`${rel}: duplicate path`);
        this.seen.add(key);
        const parts = key.split('/');
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join('/');
            if (this.fileKeys.has(parent)) throw invalid(`${rel}: a parent path is a file`);
            this.dirKeys.add(parent);
        }
        if (isDir) {
            if (this.fileKeys.has(key)) throw invalid(`${rel}: duplicate path`);
            this.dirKeys.add(key);
        } else {
            if (this.dirKeys.has(key)) throw invalid(`${rel}: duplicate path`);
            this.fileKeys.add(key);
        }
        return rel;
    }

    private inside(rel: string): string {
        const target = resolve(join(this.root, rel));
        if (target !== this.root && !target.startsWith(this.root + sep)) throw invalid(`${rel}: escapes the package`);
        return target;
    }

    private directory(rawRel: string): void {
        const rel = this.register(rawRel, true);
        if (rel !== '') mkdirSync(this.inside(rel), { recursive: true });
    }

    private writeFile(rel: string, data: Buffer): void {
        const target = this.inside(rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data, { flag: 'wx' });
    }
}

/** 把 .tgz 解到(空的)目标目录。失败时抛 PluginPackageError;已经写出的文件由调用方删除整个暂存目录。 */
export async function extractTgz(data: Buffer, dest: string, limits: TarLimits = TAR_LIMITS): Promise<void> {
    const extractor = new TarExtractor(dest, limits);
    const gunzip = createGunzip();
    const maxOut = Math.max(data.length, 1) * limits.ratio;
    let out = 0;
    gunzip.end(data);
    try {
        for await (const chunk of gunzip as AsyncIterable<Buffer>) {
            out += chunk.length;
            if (out > maxOut) throw invalid(`the package expands more than ${limits.ratio} times (decompression bomb)`);
            extractor.push(chunk);
        }
    } catch (error) {
        gunzip.destroy();
        if (error instanceof PluginPackageError) throw error;
        throw invalid(`the package is not a valid .tgz archive (${error instanceof Error ? error.message : 'error'})`);
    }
    if (!extractor.finished) throw invalid('the tar archive is truncated');
}
