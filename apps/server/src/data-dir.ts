// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 改名后的数据目录迁移(ADR 0019):~/.ai-personal → ~/.fatcat-ai,只在新目录不存在时做一次。
import { createHash } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    cpSync,
    existsSync,
    lstatSync,
    openSync,
    readdirSync,
    readlinkSync,
    readSync,
    renameSync,
    rmSync,
    statSync,
} from 'node:fs';
import { join } from 'node:path';

/** 默认数据目录(用户目录下)。 */
export const DATA_DIR_NAME = '.fatcat-ai';
/** 改名前的默认数据目录。 */
export const LEGACY_DATA_DIR_NAME = '.ai-personal';

export type DataDirMigration =
    /** 没有旧目录,无事可做。 */
    | { action: 'none' }
    /** 新旧目录都存在:不覆盖新目录,旧目录原样保留。 */
    | { action: 'kept-existing' }
    /** 原子重命名。 */
    | { action: 'renamed' }
    /** 跨盘:复制并逐文件校验后删除旧目录;`legacyRemoved` 为 false 表示旧目录删除失败(数据已在新目录)。 */
    | { action: 'copied'; legacyRemoved: boolean };

export interface MigrateOptions {
    /** 测试用:替换重命名与复制。 */
    rename?: (from: string, to: string) => void;
    copy?: (from: string, to: string) => void;
    /** 重命名遇到 EPERM / EBUSY 时的重试间隔(毫秒),依次等待;默认共重试 5 次,约 3 秒。 */
    busyRetryDelaysMs?: readonly number[];
    /** 测试用:替换同步等待。 */
    sleep?: (ms: number) => void;
}

/** 旧数据目录被其他进程占用(多见于 Windows 上旧服务器仍在运行),重试后仍无法迁移。 */
export class LegacyDataDirBusyError extends Error {
    readonly code: string;
    constructor(
        readonly from: string,
        readonly to: string,
        cause: NodeJS.ErrnoException,
    ) {
        super(
            `The old data directory ${from} is in use by another process (${cause.code}), so it cannot be moved to ${to}. ` +
                'Stop the old AI-Personal server (and anything else using that folder), then start FatCat-AI again. ' +
                'Nothing was moved or deleted.',
            { cause },
        );
        this.name = 'LegacyDataDirBusyError';
        this.code = cause.code ?? 'EBUSY';
    }
}

const BUSY_CODES = new Set(['EPERM', 'EBUSY']);
const DEFAULT_BUSY_RETRY_DELAYS_MS = [100, 250, 500, 1000, 1500];

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const defaultCopy = (from: string, to: string) =>
    cpSync(from, to, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
    });

/**
 * 旧目录存在而新目录不存在时,把旧目录迁到新位置:优先原子重命名;跨盘(EXDEV)时先复制到新目录旁的临时目录,
 * 校验每个文件的大小与 SHA-256 一致后改名为新目录,再删除旧目录。校验失败时删除临时目录并抛错,旧目录不动。
 * 新目录已存在时绝不覆盖。迁移后旧目录不再存在,所以只会做一次。
 */
export function migrateLegacyDataDir(from: string, to: string, options: MigrateOptions = {}): DataDirMigration {
    if (!existsSync(from)) return { action: 'none' };
    if (existsSync(to)) return { action: 'kept-existing' };
    try {
        renameWithBusyRetry(from, to, options);
        return { action: 'renamed' };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    }
    // 临时目录与新目录同在一个父目录下,最后一步改名不会再跨盘
    const staging = `${to}.migrating-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    try {
        (options.copy ?? defaultCopy)(from, staging);
        if (fingerprint(from) !== fingerprint(staging)) {
            throw new Error(`Copy of ${from} does not match the original; the old data directory was left in place`);
        }
        chmodSync(staging, statSync(from).mode & 0o777);
        renameSync(staging, to);
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
    try {
        rmSync(from, { recursive: true, force: true });
        return { action: 'copied', legacyRemoved: true };
    } catch {
        return { action: 'copied', legacyRemoved: false };
    }
}

/**
 * 原子重命名;Windows 上旧服务器、杀毒软件或索引程序占用目录时会得到 EPERM / EBUSY,短暂等待后重试。
 * 重命名要么整体成功要么什么都不变,所以重试不会留下部分移动的目录。重试用尽后抛出 LegacyDataDirBusyError。
 */
function renameWithBusyRetry(from: string, to: string, options: MigrateOptions): void {
    const rename = options.rename ?? renameSync;
    const delays = options.busyRetryDelaysMs ?? DEFAULT_BUSY_RETRY_DELAYS_MS;
    const sleep = options.sleep ?? sleepSync;
    for (let attempt = 0; ; attempt++) {
        try {
            rename(from, to);
            return;
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (!BUSY_CODES.has(err.code ?? '')) throw error;
            const delay = delays[attempt];
            // 等待期间若有别的进程建好了新目录,不再重试,交给调用方按「新目录已存在」报错
            if (delay === undefined || existsSync(to)) throw new LegacyDataDirBusyError(from, to, err);
            sleep(delay);
        }
    }
}

/** 目录内容的指纹:相对路径、类型、文件大小与 SHA-256、符号链接目标,按路径排序。 */
function fingerprint(root: string): string {
    const lines: string[] = [];
    const walk = (dir: string, prefix: string) => {
        for (const name of readdirSync(dir).sort()) {
            const full = join(dir, name);
            const rel = prefix ? `${prefix}/${name}` : name;
            const stat = lstatSync(full);
            if (stat.isSymbolicLink()) lines.push(`l ${rel} -> ${readlinkSync(full)}`);
            else if (stat.isDirectory()) {
                lines.push(`d ${rel}`);
                walk(full, rel);
            } else lines.push(`f ${rel} ${stat.size} ${hashFile(full)}`);
        }
    };
    walk(root, '');
    return lines.join('\n');
}

function hashFile(path: string): string {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = openSync(path, 'r');
    try {
        for (let n = readSync(fd, buffer); n > 0; n = readSync(fd, buffer)) hash.update(buffer.subarray(0, n));
    } finally {
        closeSync(fd);
    }
    return hash.digest('hex');
}
