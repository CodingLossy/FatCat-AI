// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 测试用的 ustar / .tgz 生成器:可以故意写出符号链接、`..` 路径等恶意条目。
import { gzipSync } from 'node:zlib';

export interface TarEntry {
    name: string;
    /** 普通文件的内容;不写则为空文件。 */
    data?: string | Buffer;
    /** 默认 '0'(文件);'5' 目录,'2' 符号链接,'1' 硬链接,'x' pax 扩展头等。 */
    type?: string;
    linkName?: string;
}

function field(text: string, length: number): Buffer {
    const out = Buffer.alloc(length);
    out.write(text, 0, 'utf8');
    return out;
}

function header(entry: TarEntry, size: number): Buffer {
    const block = Buffer.alloc(512);
    let name = entry.name;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
        // 第一个让剩下的名字不超过 100 字节的斜杠
        const cut = [...name].findIndex((c, i) => c === '/' && Buffer.byteLength(name.slice(i + 1)) <= 100);
        prefix = name.slice(0, cut);
        name = name.slice(cut + 1);
    }
    field(name, 100).copy(block, 0);
    field('0000644', 8).copy(block, 100);
    field('0000000', 8).copy(block, 108);
    field('0000000', 8).copy(block, 116);
    field(size.toString(8).padStart(11, '0'), 12).copy(block, 124);
    field('00000000000', 12).copy(block, 136);
    block.fill(0x20, 148, 156);
    block[156] = (entry.type ?? '0').charCodeAt(0);
    field(entry.linkName ?? '', 100).copy(block, 157);
    field('ustar', 6).copy(block, 257);
    field('00', 2).copy(block, 263);
    field(prefix, 155).copy(block, 345);
    let sum = 0;
    for (const byte of block) sum += byte;
    field(`${sum.toString(8).padStart(6, '0')}\0 `, 8).copy(block, 148);
    return block;
}

export function makeTar(entries: TarEntry[], options: { end?: boolean } = {}): Buffer {
    const parts: Buffer[] = [];
    for (const entry of entries) {
        const data = Buffer.from(entry.data ?? '');
        parts.push(header(entry, data.length));
        if (data.length > 0) {
            parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
        }
    }
    if (options.end !== false) parts.push(Buffer.alloc(1024));
    return Buffer.concat(parts);
}

export function makeTgz(entries: TarEntry[], options: { end?: boolean } = {}): Buffer {
    return gzipSync(makeTar(entries, options));
}
