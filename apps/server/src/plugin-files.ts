// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 升级与回退用的文件操作(ADR 0040 第 6.2 节):数据备份与恢复、版本目录清理。纯文件操作,不碰数据库与进程。
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** 超过这个大小的插件数据升级前不自动备份(第 6.2 节第 3 步)。 */
export const BACKUP_LIMIT_BYTES = 500 * 1024 * 1024;

const BACKUP_DIR = '.backup';

/** 目录里普通文件的总字节数;符号链接不跟随;目录不存在为 0。累计超过 `cap` 就提前返回(已经超限,不必数完)。 */
export function dirSize(dir: string, cap = Number.POSITIVE_INFINITY): number {
    let total = 0;
    const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (total > cap) return;
            const full = join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) total += lstatSync(full).size;
        }
    };
    if (existsSync(dir)) walk(dir);
    return total;
}

export function backupDir(dataRoot: string, pluginId: string, version: string): string {
    return join(dataRoot, BACKUP_DIR, pluginId, version);
}

/** 把 `plugin-data/<id>/` 复制到 `plugin-data/.backup/<id>/<版本>/`;同一版本已有的备份先删掉。返回备份目录。 */
export function backupData(dataRoot: string, pluginId: string, version: string): string {
    const target = backupDir(dataRoot, pluginId, version);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const source = join(dataRoot, pluginId);
    if (existsSync(source)) cpSync(source, target, { recursive: true });
    return target;
}

/** 用备份恢复数据目录(先清空现有内容)。没有备份返回 false,什么都不动。 */
export function restoreData(dataRoot: string, pluginId: string, version: string): boolean {
    const source = backupDir(dataRoot, pluginId, version);
    if (!existsSync(source)) return false;
    const target = join(dataRoot, pluginId);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true, mode: 0o700 });
    cpSync(source, target, { recursive: true });
    return true;
}

export function removeBackup(dataRoot: string, pluginId: string, version: string): void {
    rmSync(backupDir(dataRoot, pluginId, version), { recursive: true, force: true });
}

/** 数据备份目录里只留 `keep` 里的版本。 */
export function pruneBackups(dataRoot: string, pluginId: string, keep: string[]): void {
    const root = join(dataRoot, BACKUP_DIR, pluginId);
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
        if (!keep.includes(name)) rmSync(join(root, name), { recursive: true, force: true });
    }
    if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true });
}

/** 删除 `plugins/<id>/` 下 `keep` 以外的版本目录(升级成功后保留新旧各一份)。 */
export function pruneVersions(codeRoot: string, pluginId: string, keep: string[]): void {
    const root = join(codeRoot, pluginId);
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
        if (!keep.includes(name)) rmSync(join(root, name), { recursive: true, force: true });
    }
}

/** 删除某个插件的全部数据备份(卸载并勾选删除数据时)。 */
export function removeAllBackups(dataRoot: string, pluginId: string): void {
    rmSync(join(dataRoot, BACKUP_DIR, pluginId), { recursive: true, force: true });
}
