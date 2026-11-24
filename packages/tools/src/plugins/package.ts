// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件包的检查、复制与目录哈希(ADR 0040 第 5.1、5.4 节;本地目录来源)。安装过程不运行插件的任何代码。
import { createHash, randomBytes } from 'node:crypto';
import {
    closeSync,
    copyFileSync,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    readdirSync,
    rmSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
    PLUGIN_SKILL_INSTRUCTIONS_MAX_BYTES,
    type PluginManifest,
    parsePluginManifest,
    satisfiesEngine,
} from '@fatcat-ai/shared';

export const PACKAGE_LIMITS = {
    totalBytes: 200 * 1024 * 1024,
    files: 5000,
    fileBytes: 50 * 1024 * 1024,
    pathChars: 240,
} as const;

export class PluginPackageError extends Error {
    override readonly name = 'PluginPackageError';
    constructor(
        readonly code: 'plugin_package_invalid' | 'plugin_incompatible' | 'plugin_manifest_invalid',
        message: string,
    ) {
        super(message);
    }
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 包内相对路径是否可以安全放到各平台上;返回问题描述,没有问题时 null。 */
export function badPackagePath(rel: string): string | null {
    if (rel.length > PACKAGE_LIMITS.pathChars) return 'path is too long';
    if (isAbsolute(rel) || rel.startsWith('/') || rel.startsWith('\\')) return 'absolute path';
    for (const part of rel.split(/[\\/]/)) {
        if (part === '..') return 'path contains ".."';
        if (/^[A-Za-z]:/.test(part)) return 'drive letter';
        if (part.includes(':')) return 'colon in path (drive letter or alternate data stream)';
        const base = (part.split('.')[0] ?? part).replace(/[ .]+$/, '');
        if (RESERVED.test(base)) return `reserved Windows name "${part}"`;
        if (/[ .]$/.test(part)) return `trailing dot or space in "${part}"`;
    }
    return null;
}

interface FileEntry {
    rel: string;
    abs: string;
    size: number;
}

/** 遍历源目录并整体检查:符号链接 / junction / 硬链接 / 特殊文件 / 非法路径 / 仅大小写不同的重复 / 数量与大小上限。 */
export function scanPackageDir(root: string): { files: FileEntry[]; dirs: string[] } {
    const files: FileEntry[] = [];
    const dirs: string[] = [];
    const seen = new Set<string>();
    let total = 0;
    const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
            const abs = join(dir, name);
            const rel = relative(root, abs).split(sep).join('/');
            const problem = badPackagePath(rel);
            if (problem) throw new PluginPackageError('plugin_package_invalid', `${rel}: ${problem}`);
            const key = rel.toLowerCase();
            if (seen.has(key)) throw new PluginPackageError('plugin_package_invalid', `${rel}: duplicate path`);
            seen.add(key);
            const stat = lstatSync(abs);
            if (stat.isSymbolicLink()) {
                throw new PluginPackageError('plugin_package_invalid', `${rel}: symbolic link or junction`);
            }
            if (stat.isDirectory()) {
                dirs.push(rel);
                walk(abs);
            } else if (stat.isFile()) {
                if (stat.nlink > 1) throw new PluginPackageError('plugin_package_invalid', `${rel}: hard link`);
                if (stat.size > PACKAGE_LIMITS.fileBytes) {
                    throw new PluginPackageError('plugin_package_invalid', `${rel}: file is too large`);
                }
                total += stat.size;
                if (files.length + 1 > PACKAGE_LIMITS.files || total > PACKAGE_LIMITS.totalBytes) {
                    throw new PluginPackageError(
                        'plugin_package_invalid',
                        'the package has too many or too large files',
                    );
                }
                files.push({ rel, abs, size: stat.size });
            } else {
                throw new PluginPackageError('plugin_package_invalid', `${rel}: not a regular file`);
            }
        }
    };
    walk(root);
    return { files, dirs };
}

/** 目录 sha256:按路径排序的「相对路径 + 文件内容哈希」(ADR 0040 第 5.4 节)。 */
export function hashPluginDir(root: string): string {
    const { files } = scanPackageDir(root);
    const hash = createHash('sha256');
    for (const file of files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
        hash.update(`${file.rel}\0`);
        const inner = createHash('sha256');
        const fd = openSync(file.abs, 'r');
        try {
            const buffer = Buffer.alloc(64 * 1024);
            let read: number;
            while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) inner.update(buffer.subarray(0, read));
        } finally {
            closeSync(fd);
        }
        hash.update(inner.digest('hex'));
        hash.update('\n');
    }
    return hash.digest('hex');
}

export interface PreparedPackage {
    stagingDir: string;
    manifest: PluginManifest;
    contentSha256: string;
}

/** 把本地目录检查后复制到暂存目录并校验清单;失败时删除暂存目录。 */
export function prepareLocalPackage(
    sourceDir: string,
    options: { stagingRoot: string; coreVersion: string },
): PreparedPackage {
    if (!isAbsolute(sourceDir)) throw new PluginPackageError('plugin_package_invalid', 'the path must be absolute');
    let stat;
    try {
        stat = lstatSync(sourceDir);
    } catch {
        throw new PluginPackageError('plugin_package_invalid', 'the directory does not exist');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new PluginPackageError('plugin_package_invalid', 'the source must be a real directory');
    }
    const { files, dirs } = scanPackageDir(sourceDir);
    const stagingDir = join(options.stagingRoot, randomBytes(8).toString('hex'));
    try {
        mkdirSync(stagingDir, { recursive: true });
        for (const dir of dirs) mkdirSync(join(stagingDir, dir), { recursive: true });
        for (const file of files) copyFileSync(file.abs, join(stagingDir, file.rel));
        const { manifest, contentSha256 } = validateStagedPackage(stagingDir, options.coreVersion);
        return { stagingDir, manifest, contentSha256 };
    } catch (error) {
        rmSync(stagingDir, { recursive: true, force: true });
        throw error;
    }
}

/** 检查已放进暂存目录的包(本地复制或市场解包后共用):清单合法、入口存在、核心版本满足 engines,并算目录哈希。 */
export function validateStagedPackage(
    stagingDir: string,
    coreVersion: string,
): { manifest: PluginManifest; contentSha256: string } {
    const manifestPath = join(stagingDir, 'plugin.json');
    if (!existsSync(manifestPath)) throw new PluginPackageError('plugin_package_invalid', 'plugin.json is missing');
    const result = parsePluginManifest(readFileSync(manifestPath));
    if (!result.ok) {
        throw new PluginPackageError(
            'plugin_manifest_invalid',
            result.issues.map((i) => `${i.path}: ${i.message}`).join('; '),
        );
    }
    const { manifest } = result;
    if (manifest.entry) {
        const mainPath = join(stagingDir, manifest.entry.main);
        if (!existsSync(mainPath) || !fstatOk(mainPath)) {
            throw new PluginPackageError(
                'plugin_package_invalid',
                `entry.main "${manifest.entry.main}" does not exist`,
            );
        }
    } else {
        checkInstructionOnlyFiles(stagingDir);
    }
    for (const skill of manifest.skills ?? []) checkInstructions(stagingDir, skill.id, skill.instructions);
    if (!satisfiesEngine(coreVersion, manifest.engines.fatcat)) {
        throw new PluginPackageError(
            'plugin_incompatible',
            `requires FatCat-AI ${manifest.engines.fatcat}, this is ${coreVersion}`,
        );
    }
    return { manifest, contentSha256: hashPluginDir(stagingDir) };
}

/** 纯指令插件包里允许的文件(ADR 0048 第 2 节):`plugin.json`、markdown 和 `LICENSE` / `NOTICE`(可带 .md / .txt)。 */
export function isInstructionOnlyFile(rel: string): boolean {
    const base = rel.split('/').pop() ?? rel;
    return rel === 'plugin.json' || /\.md$/i.test(base) || /^(LICENSE|NOTICE)(\.(md|txt))?$/i.test(base);
}

function checkInstructionOnlyFiles(stagingDir: string): void {
    const { files } = scanPackageDir(stagingDir);
    const extra = files.find((file) => !isInstructionOnlyFile(file.rel));
    if (extra) {
        throw new PluginPackageError(
            'plugin_package_invalid',
            `${extra.rel}: a plugin without "entry" may only contain plugin.json, markdown and license files`,
        );
    }
}

/** Skill 的 instructions:文件存在、是普通文件、不超过 16 KiB、是合法的 UTF-8(ADR 0048 第 1 节)。 */
function checkInstructions(stagingDir: string, skillId: string, rel: string): void {
    const path = join(stagingDir, rel);
    const fail = (problem: string): never => {
        throw new PluginPackageError('plugin_package_invalid', `skill "${skillId}": instructions "${rel}" ${problem}`);
    };
    if (!existsSync(path) || !fstatOk(path)) fail('does not exist');
    const bytes = readFileSync(path);
    if (bytes.byteLength > PLUGIN_SKILL_INSTRUCTIONS_MAX_BYTES) fail('is larger than 16 KiB');
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        fail('is not valid UTF-8');
    }
}

function fstatOk(path: string): boolean {
    const fd = openSync(path, 'r');
    try {
        return fstatSync(fd).isFile();
    } finally {
        closeSync(fd);
    }
}
