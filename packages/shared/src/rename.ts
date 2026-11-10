// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 项目由 AI-Personal 改名为 FatCat-AI(ADR 0019):旧的环境变量名暂时兼容读取,并提示改用新名。

/** 本项目环境变量的前缀。 */
export const ENV_PREFIX = 'FATCAT_AI_';
/** 改名前的前缀;暂时兼容读取,以后会移除。 */
export const LEGACY_ENV_PREFIX = 'AIP_';

/** 本项目自己的配置变量(新名或旧名),这些变量永远不传给 MCP 子进程等外部程序。 */
export function isOwnEnvName(name: string): boolean {
    const upper = name.toUpperCase();
    return upper.startsWith(ENV_PREFIX) || upper.startsWith(LEGACY_ENV_PREFIX);
}

/**
 * 把旧名 `AIP_<name>` 的值补到新名 `FATCAT_AI_<name>` 上(新名已设置时以新名为准),返回实际用到的旧变量名。
 * `names` 是不带前缀的名字,如 `['HOST', 'PORT']`。会修改传入的 env。
 */
export function applyLegacyEnv(env: Record<string, string | undefined>, names: readonly string[]): string[] {
    const used: string[] = [];
    for (const name of names) {
        const legacy = `${LEGACY_ENV_PREFIX}${name}`;
        const value = env[legacy];
        if (value === undefined) continue;
        used.push(legacy);
        const current = `${ENV_PREFIX}${name}`;
        if (env[current] === undefined) env[current] = value;
    }
    return used;
}

/** 弃用提示:列出旧名与对应的新名。 */
export function legacyEnvWarning(used: readonly string[]): string {
    const pairs = used.map((name) => `${name} → ${ENV_PREFIX}${name.slice(LEGACY_ENV_PREFIX.length)}`);
    return `Deprecated environment variables (the project was renamed to FatCat-AI); please rename: ${pairs.join(', ')}`;
}
