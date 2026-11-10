// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 只读的最小 ZIP 解析(DOCX / XLSX 都是 ZIP):只支持 stored 与 deflate,不支持 ZIP64 与加密。
// 不引入第三方依赖;解压用 node:zlib,并限制单个条目与总的解压大小,防止 ZIP 炸弹。
import { inflateRawSync } from 'node:zlib';

export class DocumentError extends Error {
    override readonly name = 'DocumentError';
}

export interface ZipLimits {
    /** 单个条目解压后的上限。 */
    maxEntryBytes: number;
    /** 所有已读条目解压后的总上限。 */
    maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntryBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };

interface Entry {
    name: string;
    method: number;
    compressedSize: number;
    size: number;
    localOffset: number;
}

export class ZipReader {
    private readonly entries = new Map<string, Entry>();
    private total = 0;

    constructor(
        private readonly data: Buffer,
        private readonly limits: ZipLimits = DEFAULT_ZIP_LIMITS,
    ) {
        // 中央目录结束记录在文件末尾 22 字节 + 最多 65535 字节注释之内
        const min = Math.max(0, data.length - 22 - 0xffff);
        let eocd = -1;
        for (let i = data.length - 22; i >= min; i--) {
            if (data.readUInt32LE(i) === 0x06054b50) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) throw new DocumentError('not a ZIP file (no end of central directory)');
        const count = data.readUInt16LE(eocd + 10);
        let offset = data.readUInt32LE(eocd + 16);
        if (offset === 0xffffffff || count === 0xffff) throw new DocumentError('ZIP64 files are not supported');
        for (let i = 0; i < count; i++) {
            if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) {
                throw new DocumentError('corrupt ZIP central directory');
            }
            const flags = data.readUInt16LE(offset + 8);
            const method = data.readUInt16LE(offset + 10);
            const compressedSize = data.readUInt32LE(offset + 20);
            const size = data.readUInt32LE(offset + 24);
            const nameLength = data.readUInt16LE(offset + 28);
            const extraLength = data.readUInt16LE(offset + 30);
            const commentLength = data.readUInt16LE(offset + 32);
            const localOffset = data.readUInt32LE(offset + 42);
            const name = data.toString('utf8', offset + 46, offset + 46 + nameLength);
            if (flags & 0x1) throw new DocumentError('encrypted documents are not supported');
            this.entries.set(name, { name, method, compressedSize, size, localOffset });
            offset += 46 + nameLength + extraLength + commentLength;
        }
    }

    names(): string[] {
        return [...this.entries.keys()];
    }

    has(name: string): boolean {
        return this.entries.has(name);
    }

    /** 读出一个条目;不存在时返回 null。超出解压上限时报错。 */
    read(name: string): Buffer | null {
        const entry = this.entries.get(name);
        if (!entry) return null;
        if (entry.size > this.limits.maxEntryBytes) throw new DocumentError(`${name} is too large to extract`);
        const at = entry.localOffset;
        if (at + 30 > this.data.length || this.data.readUInt32LE(at) !== 0x04034b50) {
            throw new DocumentError('corrupt ZIP local header');
        }
        const start = at + 30 + this.data.readUInt16LE(at + 26) + this.data.readUInt16LE(at + 28);
        const raw = this.data.subarray(start, start + entry.compressedSize);
        let out: Buffer;
        if (entry.method === 0) {
            out = Buffer.from(raw);
        } else if (entry.method === 8) {
            try {
                // maxOutputLength 防止声明的大小与实际不符的 ZIP 炸弹
                out = inflateRawSync(raw, { maxOutputLength: this.limits.maxEntryBytes });
            } catch {
                throw new DocumentError(`${name} could not be decompressed (corrupt or too large)`);
            }
        } else {
            throw new DocumentError(`unsupported ZIP compression method ${entry.method}`);
        }
        this.total += out.length;
        if (this.total > this.limits.maxTotalBytes) throw new DocumentError('the document is too large to extract');
        return out;
    }

    text(name: string): string | null {
        const buffer = this.read(name);
        return buffer ? buffer.toString('utf8') : null;
    }
}
