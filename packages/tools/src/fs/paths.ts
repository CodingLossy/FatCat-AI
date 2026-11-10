// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 文件工具的路径校验(ADR 0011 第 2 节):先做词法检查,再用 realpath.native 规范化,最后检查是否落在授权目录内。
// realpath.native 会解析符号链接与 junction,并把 Windows 8.3 短名展开成长名;JS 版 realpath 不展开短名,所以只用 native。
import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { ToolDeniedError } from '../types.js';

export const MAX_PATH_LENGTH = 4096;

/** 路径不合法或越权;作为 ToolDeniedError,越权的读取也会写审计。 */
export class PathError extends ToolDeniedError {
    override readonly name = 'PathError';
}

export type Platform = NodeJS.Platform;

/** Windows 设备名:任一段等于它们(不论扩展名)都会指向设备,而不是文件。 */
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/i;

function pathApi(platform: Platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}

/** 文件系统是否不区分大小写(Windows 与 macOS 的默认设置)。 */
export function caseInsensitive(platform: Platform = process.platform): boolean {
    return platform === 'win32' || platform === 'darwin';
}

/**
 * 词法检查:不访问文件系统,不通过就拒绝。Windows 规则通过 platform 参数生效,所以在任何系统上都能测试。
 */
export function checkLexical(raw: string, platform: Platform = process.platform): void {
    if (raw.length === 0) throw new PathError('the path is empty');
    if (raw.length > MAX_PATH_LENGTH) throw new PathError('the path is too long');
    if (raw.includes('\0')) throw new PathError('the path contains a NUL character');
    if (platform !== 'win32') return;

    if (/^[\\/]{2}[?.][\\/]/.test(raw)) throw new PathError('\\\\?\\ and \\\\.\\ paths are not allowed');
    if (/^[\\/]{2}/.test(raw)) throw new PathError('UNC (network) paths are not allowed');
    // 盘符之后的冒号都表示备用数据流(file.txt:secret、file.txt::$DATA)
    const afterDrive = /^[a-z]:/i.test(raw) ? raw.slice(2) : raw;
    if (afterDrive.includes(':')) throw new PathError('NTFS alternate data streams are not allowed');
    for (const segment of raw.split(/[\\/]+/)) {
        if (segment === '' || segment === '.' || segment === '..' || /^[a-z]:$/i.test(segment)) continue;
        if (DEVICE.test(segment)) throw new PathError(`"${segment}" is a reserved device name`);
        if (/[. ]$/.test(segment)) throw new PathError(`"${segment}" ends with a dot or space`);
        // eslint-disable-next-line no-control-regex -- Windows 文件名不允许控制字符
        if (/[<>"|?*\x00-\x1f]/.test(segment))
            throw new PathError(`"${segment}" contains a character Windows does not allow`);
    }
}

/** a 是否等于 b 或在 b 之内(分隔符边界);在不区分大小写的系统上忽略大小写。 */
export function isWithin(child: string, parent: string, platform: Platform = process.platform): boolean {
    const api = pathApi(platform);
    const fold = (p: string) => (caseInsensitive(platform) ? p.toLowerCase() : p);
    const c = fold(api.normalize(child));
    const p = fold(api.normalize(parent)).replace(/[\\/]+$/, '');
    if (c === p) return true;
    return c.startsWith(p) && (c[p.length] === api.sep || (platform === 'win32' && c[p.length] === '/'));
}

/** 是否是文件系统根(/ 或 C:\);授权目录不能是它们。 */
export function isFilesystemRoot(p: string, platform: Platform = process.platform): boolean {
    const api = pathApi(platform);
    return api.parse(api.resolve(p)).root === api.resolve(p);
}

export interface ResolveOptions {
    /** 目标可以不存在(新建文件);此时父目录必须存在。 */
    allowMissing?: boolean;
    platform?: Platform;
}

/**
 * 把模型给的路径规范化为真实路径,并确认它在某个授权目录内;roots 应是已规范化的授权目录。
 * 返回规范化后的路径与它所在的授权目录。
 */
export function resolveInRoots(
    raw: string,
    roots: readonly string[],
    options: ResolveOptions = {},
): { path: string; root: string } {
    const platform = options.platform ?? process.platform;
    const api = pathApi(platform);
    checkLexical(raw, platform);
    if (roots.length === 0) throw new PathError('no folder has been authorized; add one in Settings first');

    let absolute: string;
    if (api.isAbsolute(raw)) {
        absolute = api.resolve(raw);
    } else if (roots.length === 1) {
        absolute = api.resolve(roots[0]!, raw);
    } else {
        throw new PathError('the path must be absolute when more than one folder is authorized');
    }

    let real: string;
    try {
        real = realpathSync.native(absolute);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !options.allowMissing) {
            throw new PathError(`the path does not exist: ${raw}`);
        }
        const parent = api.dirname(absolute);
        let realParent: string;
        try {
            realParent = realpathSync.native(parent);
        } catch {
            throw new PathError(`the parent folder does not exist: ${parent}`);
        }
        if (!statSync(realParent).isDirectory()) throw new PathError(`not a folder: ${parent}`);
        real = api.join(realParent, api.basename(absolute));
    }

    // 授权目录本身也在每次调用时重新 realpath:目录被换成链接时,以链接指向的真实位置为准
    for (const root of roots) {
        let realRoot: string;
        try {
            realRoot = realpathSync.native(root);
        } catch {
            continue;
        }
        if (isWithin(real, realRoot, platform)) return { path: real, root: realRoot };
    }
    throw new PathError(`the path is outside the authorized folders: ${raw}`);
}

/** 写入 / 移动前:已存在的目标不能是链接(包括 junction)或目录。 */
export function checkWritableTarget(real: string): 'missing' | 'file' {
    let info;
    try {
        info = lstatSync(real);
    } catch {
        return 'missing';
    }
    if (info.isSymbolicLink()) throw new PathError('the target is a link; links are never written through');
    if (info.isDirectory()) throw new PathError('the target is a folder');
    return 'file';
}

/** 规范化一个授权目录(POST /fs/roots):必须存在、是目录、不是文件系统根。 */
export function normalizeRoot(raw: string, platform: Platform = process.platform): string {
    checkLexical(raw, platform);
    const api = pathApi(platform);
    if (!api.isAbsolute(raw)) throw new PathError('the folder must be an absolute path');
    let real: string;
    try {
        real = realpathSync.native(api.resolve(raw));
    } catch {
        throw new PathError(`the folder does not exist: ${raw}`);
    }
    if (!statSync(real).isDirectory()) throw new PathError(`not a folder: ${raw}`);
    if (isFilesystemRoot(real, platform))
        throw new PathError('a whole drive or the filesystem root cannot be authorized');
    return real;
}
