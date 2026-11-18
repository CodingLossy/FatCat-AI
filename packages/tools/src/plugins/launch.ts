// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件子进程的启动参数与环境(ADR 0040 第 4 节):权限模型、预加载、不继承环境、密钥只经启动环境传入。
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOwnEnvName } from '@fatcat-ai/shared';

/** 预加载脚本的路径:打包后是 preload.js;从源码直接跑(测试)时是 preload.ts。 */
export function preloadScriptPath(): string {
    const dir = dirname(fileURLToPath(import.meta.url));
    const js = join(dir, 'preload.js');
    return existsSync(js) ? js : join(dir, 'preload.ts');
}

export interface PluginLaunchInput {
    /** 插件代码目录(只读):`<数据目录>/plugins/<id>/<version>`。 */
    codeDir: string;
    /** 插件数据目录(读写):`<数据目录>/plugin-data/<id>`。 */
    dataDir: string;
    /** 清单 `entry.main`(包内相对路径)。 */
    main: string;
    preload?: string | undefined;
    /** 可选:V8 堆上限(MiB);默认不传。 */
    maxOldSpaceMiB?: number | undefined;
    maxSemiSpaceMiB?: number | undefined;
}

/** `node` 的参数(不含可执行文件本身)。不给 --allow-child-process / --allow-worker / --allow-addons / --allow-wasi。 */
export function pluginNodeArgs(input: PluginLaunchInput): string[] {
    const preload = input.preload ?? preloadScriptPath();
    const code = resolve(input.codeDir);
    const data = resolve(input.dataDir);
    const args = [
        '--permission',
        `--allow-fs-read=${code}`,
        `--allow-fs-read=${data}`,
        `--allow-fs-read=${preload}`,
        `--allow-fs-write=${data}`,
    ];
    if (input.maxOldSpaceMiB) args.push(`--max-old-space-size=${Math.floor(input.maxOldSpaceMiB)}`);
    if (input.maxSemiSpaceMiB) args.push(`--max-semi-space-size=${Math.floor(input.maxSemiSpaceMiB)}`);
    args.push(`--import=${pathToFileUrlSafe(preload)}`, join(code, input.main));
    return args;
}

function pathToFileUrlSafe(path: string): string {
    // --import 在 Windows 上需要 file:// URL(盘符路径会被当成协议);各平台统一用 URL 形式
    return new URL(`file://${path.startsWith('/') ? '' : '/'}${path.replaceAll('\\', '/')}`).href;
}

const BASE_ENV = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir', 'LANG', 'PATHEXT'];

export interface PluginEnvInput {
    pluginId: string;
    dataDir: string;
    /** 已解析的密钥:声明的名字 -> 值(取自主程序自己的进程环境)。 */
    secrets: Record<string, string>;
    /** 用户时区(ADR 0023)。 */
    timeZone?: string | undefined;
    source?: NodeJS.ProcessEnv | undefined;
}

/** 子进程环境(第 4.2 节):不继承主程序环境;FATCAT_AI_* / AIP_* / NODE_OPTIONS / NODE_PATH 永远不传。 */
export function pluginEnv(input: PluginEnvInput): Record<string, string> {
    const source = input.source ?? process.env;
    const env: Record<string, string> = {};
    for (const name of BASE_ENV) {
        const value = source[name];
        if (value !== undefined && !isOwnEnvName(name)) env[name] = value;
    }
    if (input.timeZone) env.TZ = input.timeZone;
    else if (source.TZ) env.TZ = source.TZ;
    const home = join(input.dataDir, 'home');
    const tmp = join(input.dataDir, 'tmp');
    env.HOME = home;
    env.USERPROFILE = home;
    env.TMPDIR = tmp;
    env.TEMP = tmp;
    env.TMP = tmp;
    env.FATCAT_PLUGIN_ID = input.pluginId;
    env.FATCAT_PLUGIN_DATA = input.dataDir;
    for (const [name, value] of Object.entries(input.secrets)) {
        if (isOwnEnvName(name) || name === 'NODE_OPTIONS' || name === 'NODE_PATH') continue;
        env[name] = value;
    }
    return env;
}

/** 启动前检查数据目录里没有符号链接、junction 或其他重解析点(libuv 把 junction 也报成符号链接)。返回问题描述,没有问题时 null。 */
export function findReparsePoint(root: string, limit = 100_000): string | null {
    let seen = 0;
    const walk = (dir: string): string | null => {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return null;
        }
        for (const name of entries) {
            if (++seen > limit) return `${dir}: too many entries to check`;
            const full = join(dir, name);
            const stat = lstatSync(full);
            if (stat.isSymbolicLink()) return `${full}: symbolic link or junction`;
            if (stat.isFile() && stat.nlink > 1) return `${full}: hard link`;
            if (stat.isDirectory()) {
                const inner = walk(full);
                if (inner) return inner;
            }
        }
        return null;
    };
    try {
        if (lstatSync(root).isSymbolicLink()) return `${root}: symbolic link or junction`;
    } catch {
        return null; // 还不存在:由调用方创建
    }
    return walk(root);
}
