// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 明文 secrets.yaml → 加密文件的迁移、换主密钥、清理(ADR 0026 第 5、8 节)。只含文件层的纯逻辑;
// 路由与命令行只是调用这里。任何一步失败都保留原文件,可重复执行;返回值与错误里没有密钥值。
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlaintextBackupAction, SecretsMigrateResponse, SecretsStatus, MasterKeySource } from '@fatcat-ai/shared';
import {
    constantTimeEqual,
    decryptSecrets,
    encryptSecrets,
    keyFingerprint,
    type MasterKeyResolver,
    SecretsKeyUnavailableError,
} from './secrets-crypto.js';
import {
    backupSecrets,
    parseSecretsFile,
    restrictToCurrentUser,
    SECRETS_BACKUP_DIR,
    SECRETS_BACKUP_PATTERN,
    SECRETS_ENC_FILE,
    SECRETS_FILE,
    SECRETS_MIGRATED_FILE,
    secretsLayout,
    writeFileAtomic,
} from './secrets.js';

export class SecretsMigrateError extends Error {
    override readonly name = 'SecretsMigrateError';
    constructor(
        readonly code:
            | 'nothing_to_migrate'
            | 'already_encrypted'
            | 'conflict'
            | 'key_unavailable'
            | 'plaintext_invalid'
            | 'write_failed'
            | 'verify_failed'
            | 'not_encrypted',
        message: string,
    ) {
        super(message);
    }
}

/** 测试里注入失败;生产不传。 */
export interface MigrateHooks {
    /** 替换写 .enc.tmp 之后的步骤(例如抛 EACCES 模拟只读目录)。 */
    beforeWrite?: () => void;
    /** 替换回读:返回解密后的文本(用来模拟回读不一致)。 */
    readBack?: (path: string, key: Buffer) => string;
    restrict?: (path: string) => void;
    onWarning?: (message: string) => void;
}

const tightener = (hooks?: MigrateHooks) => (file: string) => {
    try {
        (hooks?.restrict ?? ((p: string) => restrictToCurrentUser(p, { onWarning: hooks?.onWarning })))(file);
    } catch {
        hooks?.onWarning?.('could not restrict a secrets file to the current user; the file was kept');
    }
};

/** 逐键常数时间比对两个映射:键集合相同、每个值相同。值不进错误信息。 */
export function secretMapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
    if (a.size !== b.size) return false;
    let same = true;
    for (const [name, value] of a) {
        const other = b.get(name);
        // 不提前退出,保持常数时间
        same = other !== undefined && constantTimeEqual(value, other) && same;
    }
    return same;
}

function backupFiles(dataDir: string): { plaintext: string[]; encrypted: string[] } {
    const dir = join(dataDir, SECRETS_BACKUP_DIR);
    if (!existsSync(dir)) return { plaintext: [], encrypted: [] };
    const all = readdirSync(dir).filter((f) => SECRETS_BACKUP_PATTERN.test(f));
    return { plaintext: all.filter((f) => f.endsWith('.yaml')), encrypted: all.filter((f) => f.endsWith('.enc')) };
}

/** GET /settings/secrets 的内容:状态、主密钥来源与指纹、密钥是否可用、备份份数。没有任何密钥值。 */
export function readSecretsStatus(dataDir: string, keys: MasterKeyResolver | undefined): SecretsStatus {
    const layout = secretsLayout(dataDir);
    if (layout === 'conflict') throw new SecretsMigrateError('conflict', 'plaintext and encrypted secrets both exist');
    let source: MasterKeySource = 'none';
    let key: Buffer | null = null;
    try {
        const found = keys?.current();
        if (found) {
            source = found.source;
            key = found.key;
        }
    } catch {
        // 启动时已经报过格式错误;这里按「不可用」处理
        key = null;
    }
    let keyAvailable = true;
    if (layout === 'encrypted') {
        keyAvailable = false;
        if (key) {
            try {
                decryptSecrets(readFileSync(join(dataDir, SECRETS_ENC_FILE), 'utf8'), key);
                keyAvailable = true;
            } catch {
                keyAvailable = false;
            }
        }
    }
    const b = backupFiles(dataDir);
    return {
        file: layout === 'none' ? 'none' : layout === 'encrypted' ? 'encrypted' : 'plaintext',
        masterKeySource: source,
        keyAvailable,
        fingerprint: key ? keyFingerprint(key) : null,
        backups: { total: b.plaintext.length + b.encrypted.length, plaintext: b.plaintext.length },
    };
}

function migratedNames(dataDir: string): string[] {
    return readdirSync(dataDir).filter((f) => f === SECRETS_MIGRATED_FILE || /^secrets\.yaml\.migrated\.\d+$/.test(f));
}

function nextMigratedName(dataDir: string): string {
    let name = SECRETS_MIGRATED_FILE;
    for (let n = 2; existsSync(join(dataDir, name)); n++) name = `${SECRETS_MIGRATED_FILE}.${n}`;
    return name;
}

export interface MigrateOptions {
    dataDir: string;
    keys: MasterKeyResolver;
    plaintextBackups?: PlaintextBackupAction;
    now?: Date;
    hooks?: MigrateHooks;
}

/**
 * 迁移顺序固定:备份 → 写 secrets.yaml.enc.tmp(fsync)后改名 → 解密回读并逐键常数时间比对 → 全部通过后明文改名为 secrets.yaml.migrated。
 * 任一步失败:删掉临时文件(和已改名的新文件),明文保持原样,抛 SecretsMigrateError;可重复执行。
 * 上次迁移在最后一步之前中断(明文与密文并存)时,若密文与明文逐键一致则只补完最后一步。
 */
export function migrateSecrets(options: MigrateOptions): SecretsMigrateResponse {
    const { dataDir, keys, hooks } = options;
    const now = options.now ?? new Date();
    const mode = options.plaintextBackups ?? 'keep';
    const tighten = tightener(hooks);
    const plainPath = join(dataDir, SECRETS_FILE);
    const encPath = join(dataDir, SECRETS_ENC_FILE);
    const layout = secretsLayout(dataDir);
    if (layout === 'none') throw new SecretsMigrateError('nothing_to_migrate', 'there is no secrets file to migrate');
    if (layout === 'encrypted') throw new SecretsMigrateError('already_encrypted', 'secrets are already encrypted');

    let text: string;
    let values: Map<string, string>;
    try {
        text = readFileSync(plainPath, 'utf8');
        values = parseSecretsFile(text);
    } catch (error) {
        throw new SecretsMigrateError(
            'plaintext_invalid',
            `${SECRETS_FILE} cannot be read: ${(error as Error).message}`,
        );
    }

    let resolution;
    try {
        resolution = layout === 'conflict' ? keys.current() : keys.ensure();
    } catch {
        throw new SecretsMigrateError('key_unavailable', 'the master key is not usable');
    }
    const key = resolution.key;
    if (!key) throw new SecretsMigrateError('key_unavailable', 'the master key is not usable');

    /** 解密回读并与明文逐键比对;读不出来也算不一致。 */
    const matches = (path: string): boolean => {
        try {
            const back = (hooks?.readBack ?? ((p, k) => decryptSecrets(readFileSync(p, 'utf8'), k)))(path, key);
            return secretMapsEqual(values, parseSecretsFile(back));
        } catch {
            return false;
        }
    };

    // 并存:只在密文与明文逐键一致时补完最后一步
    if (layout === 'conflict') {
        if (!matches(encPath)) {
            throw new SecretsMigrateError(
                'conflict',
                `${SECRETS_FILE} and ${SECRETS_ENC_FILE} both exist and differ; neither was changed. Move away the one you do not want.`,
            );
        }
        return finish(dataDir, now, mode, tighten, null, key, values.size);
    }

    // 1. 备份
    let backup: string;
    try {
        backup = backupSecrets(dataDir, plainPath, now, tighten, false);
    } catch (error) {
        throw new SecretsMigrateError('write_failed', `cannot back up ${SECRETS_FILE}: ${code(error)}`);
    }
    // 2. 写 .enc.tmp,fsync 后改名
    try {
        hooks?.beforeWrite?.();
        writeFileAtomic(dataDir, encPath, encryptSecrets(text, key), `${SECRETS_ENC_FILE}.tmp`);
        tighten(encPath);
    } catch (error) {
        rmSync(join(dataDir, `${SECRETS_ENC_FILE}.tmp`), { force: true });
        throw new SecretsMigrateError('write_failed', `cannot write ${SECRETS_ENC_FILE}: ${code(error)}`);
    }
    // 3. 解密回读,逐键比对
    if (!matches(encPath)) {
        rmSync(encPath, { force: true }); // 这个文件是本次刚建的(迁移前不存在密文)
        throw new SecretsMigrateError(
            'verify_failed',
            `the encrypted copy did not match ${SECRETS_FILE}; nothing was changed`,
        );
    }
    // 4. 全部通过后才处理明文
    return finish(dataDir, now, mode, tighten, backup, key, values.size);
}

function code(error: unknown): string {
    return (error as NodeJS.ErrnoException).code ?? 'error';
}

function finish(
    dataDir: string,
    now: Date,
    mode: PlaintextBackupAction,
    tighten: (file: string) => void,
    backup: string | null,
    key: Buffer,
    migratedKeys: number,
): SecretsMigrateResponse {
    try {
        renameSync(join(dataDir, SECRETS_FILE), join(dataDir, nextMigratedName(dataDir)));
    } catch (error) {
        // 改名失败:删掉新密文,明文原样保留
        rmSync(join(dataDir, SECRETS_ENC_FILE), { force: true });
        throw new SecretsMigrateError('write_failed', `cannot rename ${SECRETS_FILE}: ${code(error)}`);
    }
    const counts = { kept: 0, encrypted: 0, deleted: 0 };
    const dir = join(dataDir, SECRETS_BACKUP_DIR);
    for (const name of backupFiles(dataDir).plaintext) {
        if (mode === 'keep') {
            counts.kept++;
            continue;
        }
        const from = join(dir, name);
        try {
            if (mode === 'encrypt') {
                const target = join(dir, `${name}.enc`);
                writeFileSync(target, encryptSecrets(readFileSync(from, 'utf8'), key), { mode: 0o600 });
                tighten(target);
                rmSync(from, { force: true });
                if (backup === name) backup = `${name}.enc`;
                counts.encrypted++;
            } else {
                rmSync(from, { force: true });
                counts.deleted++;
            }
        } catch {
            counts.kept++; // 处理失败的备份保持原样
        }
    }
    return {
        migratedKeys,
        backup: backup ?? 'none',
        fingerprint: keyFingerprint(key),
        plaintextBackups: counts,
    };
}

export interface RekeyOptions {
    dataDir: string;
    oldKey: Buffer;
    newKey: Buffer;
    now?: Date;
    hooks?: MigrateHooks;
}

/**
 * 换主密钥(服务器停止时运行):旧密钥解密 → 备份(密文原样)→ 新密钥加密写临时文件 → 用新密钥回读比对 → 替换。
 * 失败保留原文件。只处理 secrets 文件;数据库里 TOTP 密钥的重新加密在 PR 5。
 */
export function rekeySecrets(options: RekeyOptions): { keys: number; fingerprint: string; backup: string } {
    const { dataDir, oldKey, newKey, hooks } = options;
    const tighten = tightener(hooks);
    const encPath = join(dataDir, SECRETS_ENC_FILE);
    const layout = secretsLayout(dataDir);
    if (layout !== 'encrypted') {
        throw new SecretsMigrateError(
            layout === 'conflict' ? 'conflict' : 'not_encrypted',
            'there is no encrypted secrets file to re-encrypt',
        );
    }
    let text: string;
    try {
        text = decryptSecrets(readFileSync(encPath, 'utf8'), oldKey);
    } catch (error) {
        if (error instanceof SecretsKeyUnavailableError)
            throw new SecretsMigrateError('key_unavailable', error.message);
        throw new SecretsMigrateError('verify_failed', (error as Error).message);
    }
    const values = parseSecretsFile(text);
    let backup: string;
    try {
        backup = backupSecrets(dataDir, encPath, options.now ?? new Date(), tighten, true);
    } catch (error) {
        throw new SecretsMigrateError('write_failed', `cannot back up ${SECRETS_ENC_FILE}: ${code(error)}`);
    }
    const tmp = `${SECRETS_ENC_FILE}.tmp`;
    const tmpPath = join(dataDir, tmp);
    try {
        hooks?.beforeWrite?.();
        rmSync(tmpPath, { force: true });
        writeFileSync(tmpPath, encryptSecrets(text, newKey), { mode: 0o600, flag: 'wx' });
        let ok = false;
        try {
            const back = (hooks?.readBack ?? ((p, k) => decryptSecrets(readFileSync(p, 'utf8'), k)))(tmpPath, newKey);
            ok = secretMapsEqual(values, parseSecretsFile(back));
        } catch {
            ok = false;
        }
        if (!ok)
            throw new SecretsMigrateError('verify_failed', 'the re-encrypted copy did not match; nothing was changed');
        renameSync(tmpPath, encPath);
        tighten(encPath);
    } catch (error) {
        rmSync(tmpPath, { force: true });
        if (error instanceof SecretsMigrateError) throw error;
        throw new SecretsMigrateError('write_failed', `cannot write ${SECRETS_ENC_FILE}: ${code(error)}`);
    }
    return { keys: values.size, fingerprint: keyFingerprint(newKey), backup };
}

/**
 * 清理迁移留下的 secrets.yaml.migrated:只在加密文件当前能用主密钥解开时才删,避免两头都丢。返回删除的文件数。
 */
export function cleanupMigrated(dataDir: string, keys: MasterKeyResolver): number {
    if (secretsLayout(dataDir) !== 'encrypted') {
        throw new SecretsMigrateError('not_encrypted', 'cleanup needs a working encrypted secrets file');
    }
    const key = keys.current().key;
    if (!key) throw new SecretsMigrateError('key_unavailable', 'the master key is not usable');
    try {
        parseSecretsFile(decryptSecrets(readFileSync(join(dataDir, SECRETS_ENC_FILE), 'utf8'), key));
    } catch {
        throw new SecretsMigrateError(
            'key_unavailable',
            'the encrypted secrets file cannot be read with the current key',
        );
    }
    const names = migratedNames(dataDir);
    for (const name of names) rmSync(join(dataDir, name), { force: true });
    return names.length;
}
