// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Redactor } from './redact.js';

/** 数据目录下的本地密钥文件;file:NAME 引用其中的键(ADR 0006 第 2 节)。 */
export const SECRETS_FILE = 'secrets.yaml';

export class SecretsFileError extends Error {
    override readonly name = 'SecretsFileError';
}

/**
 * 只支持「扁平映射」这一 YAML 子集:每行 `NAME: value`,值可用单 / 双引号包裹,`#` 开头为注释。
 * 不支持嵌套、多行值与锚点;遇到不认识的行直接报错,不猜测含义。
 */
export function parseSecretsFile(text: string): Map<string, string> {
    const out = new Map<string, string>();
    text.split(/\r?\n/).forEach((raw, index) => {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) return;
        const match = /^([A-Za-z_][A-Za-z0-9_]{0,63})\s*:\s*(.*)$/.exec(line);
        if (!match) throw new SecretsFileError(`${SECRETS_FILE} line ${index + 1}: expected "NAME: value"`);
        const name = match[1]!;
        let value = match[2]!.trim();
        const quoted = /^(["'])(.*)\1$/.exec(value);
        if (quoted) {
            value = quoted[2]!;
        } else {
            value = value.replace(/\s+#.*$/, '');
        }
        if (raw.startsWith(' ') || raw.startsWith('\t')) {
            throw new SecretsFileError(`${SECRETS_FILE} line ${index + 1}: nested values are not supported`);
        }
        out.set(name, value);
    });
    return out;
}

export type KeyStatusValue = 'present' | 'missing' | 'not_required';

export interface SecretStoreOptions {
    dataDir: string;
    env?: NodeJS.ProcessEnv;
    redactor: Redactor;
    /** 文件权限过宽等提示;不包含任何密钥内容。 */
    onWarning?: (message: string) => void;
}

/**
 * 解析 apiKeyRef。明文只在调用方发请求的那一刻取得,不缓存到长期对象里;
 * 每次取得的值都登记到脱敏器。
 */
export class SecretStore {
    private cache: { mtimeMs: number; values: Map<string, string> } | null = null;
    private warnedPermissions = false;

    constructor(private readonly options: SecretStoreOptions) {}

    private fileValues(): Map<string, string> {
        const path = join(this.options.dataDir, SECRETS_FILE);
        let stat;
        try {
            stat = statSync(path);
        } catch {
            this.cache = null;
            return new Map();
        }
        if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0 && !this.warnedPermissions) {
            this.warnedPermissions = true;
            this.options.onWarning?.(`${SECRETS_FILE} is readable by other users; run: chmod 600 ${path}`);
        }
        if (this.cache?.mtimeMs !== stat.mtimeMs) {
            this.cache = { mtimeMs: stat.mtimeMs, values: parseSecretsFile(readFileSync(path, 'utf8')) };
        }
        return this.cache.values;
    }

    /** 返回密钥明文;ref 为 null 时返回 null;引用的值不存在时也返回 null。 */
    resolve(ref: string | null): string | null {
        if (ref === null) return null;
        const match = /^(env|file):([A-Za-z_][A-Za-z0-9_]{0,63})$/.exec(ref);
        if (!match) return null;
        const [, scheme, name] = match as unknown as [string, 'env' | 'file', string];
        const value = scheme === 'env' ? (this.options.env ?? process.env)[name] : this.fileValues().get(name);
        if (!value) return null;
        this.options.redactor.add(value);
        return value;
    }

    status(ref: string | null): KeyStatusValue {
        if (ref === null) return 'not_required';
        try {
            return this.resolve(ref) ? 'present' : 'missing';
        } catch {
            return 'missing';
        }
    }
}
