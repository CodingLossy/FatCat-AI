// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_SERVER = 'http://127.0.0.1:8787';

/** ~/.ai-personal/cli.json 的内容;只有服务器地址与令牌,令牌从不打印。 */
export interface CliConfigFile {
    server?: string;
    token?: string;
    /** 令牌 id,logout 时用来吊销。 */
    tokenId?: string;
}

export interface ResolvedConfig {
    server: string;
    token: string | undefined;
    tokenId: string | undefined;
    /** 令牌来自哪里(用于提示,不含令牌本身)。 */
    tokenSource: 'env' | 'file' | null;
    path: string;
}

export function configPath(env: NodeJS.ProcessEnv): string {
    return env.AIP_CLI_CONFIG || join(homedir(), '.ai-personal', 'cli.json');
}

export function readConfigFile(path: string): CliConfigFile {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as CliConfigFile) : {};
    } catch {
        return {};
    }
}

/** 写入配置:目录 0700、文件 0600,先写临时文件再改名,避免写一半。 */
export function writeConfigFile(path: string, config: CliConfigFile): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
}

export function removeConfigFile(path: string): void {
    rmSync(path, { force: true });
}

/** 优先级:命令行参数 > 环境变量 AIP_SERVER / AIP_TOKEN > 配置文件(M1 方案第 5 节)。 */
export function resolveConfig(env: NodeJS.ProcessEnv, flags: { server?: string | undefined }): ResolvedConfig {
    const path = configPath(env);
    const file = readConfigFile(path);
    const server = (flags.server || env.AIP_SERVER || file.server || DEFAULT_SERVER).replace(/\/+$/, '');
    const envToken = env.AIP_TOKEN || undefined;
    // 文件里的令牌只属于文件里的那个服务器,换了服务器就不能带过去
    const fileToken = !file.server || file.server.replace(/\/+$/, '') === server ? file.token : undefined;
    const token = envToken ?? fileToken;
    return {
        server,
        token,
        tokenId: envToken ? undefined : file.tokenId,
        tokenSource: envToken ? 'env' : fileToken ? 'file' : null,
        path,
    };
}
