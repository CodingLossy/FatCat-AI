// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { homedir } from 'node:os';
import { join } from 'node:path';
import { OFFICIAL_SOURCE_URL } from '@ai-personal/shared';

export type CookieSecure = 'auto' | 'always' | 'never';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 运行时配置,全部来自环境变量;默认只监听本机(见计划第 7 节)。 */
export interface ServerConfig {
    host: string;
    port: number;
    /** 当前部署的完整源码地址(AGPL §13);默认为官方仓库,修改版部署者应改为自己的源码地址。 */
    sourceUrl: string;
    /** 若设置,则由核心服务托管 Web UI 构建产物。 */
    webDir: string | null;
    /** 数据目录:db.sqlite、backups/、secrets.yaml 等(计划第 4 节)。 */
    dataDir: string;
    /** 会话 Cookie 的 Secure 属性:auto 表示仅在 HTTPS 请求上设置。 */
    cookieSecure: CookieSecure;
    /** 首次初始化用的一次性设置码;未设置时启动时随机生成并打印到日志。 */
    setupCode: string | null;
    logLevel: LogLevel;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
    if (value === undefined || value === '') return fallback;
    if (!(allowed as readonly string[]).includes(value)) {
        throw new Error(`${name} must be one of ${allowed.join(', ')}; got "${value}"`);
    }
    return value as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    const port = env.AIP_PORT === undefined ? DEFAULT_PORT : Number(env.AIP_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`AIP_PORT is invalid: ${env.AIP_PORT}`);
    }
    const setupCode = env.AIP_SETUP_CODE || null;
    if (setupCode !== null && setupCode.length < 8) {
        throw new Error('AIP_SETUP_CODE must be at least 8 characters');
    }
    return {
        host: env.AIP_HOST ?? DEFAULT_HOST,
        port,
        sourceUrl: env.AIP_SOURCE_URL || OFFICIAL_SOURCE_URL,
        webDir: env.AIP_WEB_DIR || null,
        dataDir: env.AIP_DATA_DIR || join(homedir(), '.ai-personal'),
        cookieSecure: oneOf('AIP_COOKIE_SECURE', env.AIP_COOKIE_SECURE, ['auto', 'always', 'never'], 'auto'),
        setupCode,
        logLevel: oneOf('AIP_LOG_LEVEL', env.AIP_LOG_LEVEL, ['debug', 'info', 'warn', 'error'], 'info'),
    };
}
