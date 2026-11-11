// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
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

/** 写入 secrets.yaml 失败(解析失败、键名或值不合法、文件系统错误);原文件保持不变。 */
export class SecretsWriteError extends Error {
    override readonly name = 'SecretsWriteError';
    readonly code = 'secrets_write_failed';
}

/** secrets.yaml 的备份目录(相对数据目录)与保留份数(ADR 0022 第 9 节)。 */
export const SECRETS_BACKUP_DIR = 'backups';
export const SECRETS_BACKUP_KEEP = 5;

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function backupStamp(now: Date): string {
    return now
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');
}

function quoteValue(value: string): string {
    if (value === '' || /[\r\n]/.test(value))
        throw new SecretsWriteError('secret value must be a non-empty single line');
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes('"')) return `"${value}"`;
    throw new SecretsWriteError('secret value cannot contain both quote characters');
}

/**
 * 在 secrets.yaml 里新增、更新(value 为字符串)或删除(value 为 null)一个键(ADR 0022 第 9 节):
 * 先解析现有内容,失败则抛 SecretsWriteError 且不动文件;改动前把原文件备份到 backups/secrets-<UTC>.yaml(只留最近 5 份);
 * 按行处理,只改目标键那一行,其他行与换行符风格逐字节不变;写临时文件后原子改名,权限 600。
 * 返回 false 表示内容没有变化(没有写入,也没有备份)。
 */
export function writeSecretsKey(dataDir: string, name: string, value: string | null, now = new Date()): boolean {
    if (!SECRET_NAME.test(name)) throw new SecretsWriteError('invalid secret name');
    const path = join(dataDir, SECRETS_FILE);
    const exists = existsSync(path);
    let text = '';
    try {
        if (exists) text = readFileSync(path, 'utf8');
        parseSecretsFile(text);
    } catch (error) {
        throw new SecretsWriteError(error instanceof SecretsFileError ? error.message : `cannot read ${SECRETS_FILE}`);
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(eol);
    const keyLine = new RegExp(`^${name}\\s*:`);
    let index = -1;
    lines.forEach((line, i) => {
        if (keyLine.test(line)) index = i;
    });
    if (value === null) {
        if (index < 0) return false;
        lines.splice(index, 1);
    } else {
        const line = `${name}: ${quoteValue(value)}`;
        if (index >= 0) {
            if (lines[index] === line) return false;
            lines[index] = line;
        } else if (text === '') {
            lines.splice(0, 1, line, '');
        } else if (lines[lines.length - 1] === '') {
            lines.splice(lines.length - 1, 0, line);
        } else {
            lines.push(line, '');
        }
    }
    const next = lines.join(eol);
    const tmp = join(dataDir, `.${SECRETS_FILE}.${randomBytes(6).toString('hex')}.tmp`);
    try {
        if (exists) backupSecrets(dataDir, path, now);
        writeFileSync(tmp, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        renameSync(tmp, path);
    } catch (error) {
        rmSync(tmp, { force: true });
        throw new SecretsWriteError(
            `cannot write ${SECRETS_FILE}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
        );
    }
    return true;
}

function backupSecrets(dataDir: string, path: string, now: Date): void {
    const dir = join(dataDir, SECRETS_BACKUP_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let target = join(dir, `secrets-${backupStamp(now)}.yaml`);
    for (let n = 2; existsSync(target); n++) target = join(dir, `secrets-${backupStamp(now)}-${n}.yaml`);
    // 先建 600 的空文件再复制,避免复制出来的文件短暂带上宽松权限
    writeFileSync(target, '', { mode: 0o600, flag: 'wx' });
    copyFileSync(path, target);
    const old = readdirSync(dir)
        .filter((f) => /^secrets-\d{8}T\d{6}Z(-\d+)?\.yaml$/.test(f))
        .sort();
    for (const f of old.slice(0, Math.max(0, old.length - SECRETS_BACKUP_KEEP))) rmSync(join(dir, f), { force: true });
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

    /** 写入运行时令牌(新增或更新 file: 引用的键);值登记到脱敏器。规则见 writeSecretsKey。 */
    write(name: string, value: string, now?: Date): void {
        this.options.redactor.add(value);
        writeSecretsKey(this.options.dataDir, name, value, now);
        this.cache = null;
    }

    /** 删除一个键(删除渠道时);同样先备份、只删这一行。 */
    remove(name: string, now?: Date): void {
        writeSecretsKey(this.options.dataDir, name, null, now);
        this.cache = null;
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
