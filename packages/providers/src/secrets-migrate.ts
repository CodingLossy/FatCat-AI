// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 明文 secrets.yaml → 加密文件的迁移、换主密钥、清理(ADR 0026 第 5、8 节)。只含文件层的纯逻辑;
// 路由与命令行只是调用这里。任何一步失败都保留原文件,可重复执行;返回值与错误里没有密钥值。
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
    pruneBackups,
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
    const migratedName = nextMigratedName(dataDir);
    try {
        renameSync(join(dataDir, SECRETS_FILE), join(dataDir, migratedName));
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
                // 刚做的那份备份也被删了:回滚副本是改名后的明文 secrets.yaml.migrated,返回它而不是已删除的文件
                if (backup === name) backup = migratedName;
            }
        } catch {
            counts.kept++; // 处理失败的备份保持原样
        }
    }
    // 加密备份同样只留最近几份(.enc 加上迁移时转成密文的那些)
    if (mode === 'encrypt' && counts.encrypted > 0) {
        try {
            pruneBackups(dir, '.yaml.enc');
        } catch {
            // 清理失败不影响迁移结果
        }
        if (backup !== null && !existsSync(join(dir, backup))) backup = migratedName;
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

export interface RekeyResult {
    keys: number;
    fingerprint: string;
    /** 换钥前的密文备份(已用新密钥重新加密,可以用新密钥解开)。 */
    backup: string;
    /** 一并改用新密钥的加密备份份数(含上面那份)。 */
    backupsRekeyed: number;
    /** 用旧密钥解不开(本来就不可用)、保持原样的加密备份。 */
    backupsSkipped: string[];
    /** 把本次改动的文件全部恢复成换钥前的字节(旧密钥)。后续步骤失败时由调用方使用;失败时抛错。 */
    rollback: () => void;
}

/**
 * 换主密钥(服务器停止时运行)。旧密钥解密 → 备份(旧密钥,留作回滚)→ 把主文件和 backups/ 下所有 .yaml.enc 备份
 * 都用新密钥加密写成临时文件 → 逐个用新密钥回读比对 → 全部通过后才改名替换。任何一个失败,临时文件删掉,
 * 已经改名的恢复成原来的字节(内存里保留着),抛 SecretsMigrateError。否则换钥之后旧备份会静默变成解不开的文件。
 * 用旧密钥解不开的备份(例如更早一次换钥留下的)不属于本次失败:保持原样并在结果里列出。
 * 只处理 secrets 文件与它的备份;数据库里 TOTP 密钥的重新加密在 apps/server 的命令里。
 */
export function rekeySecrets(options: RekeyOptions): RekeyResult {
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

    // 要换钥的文件:主文件 + 所有加密备份(含刚做的那份)。原始字节留在内存里,失败时按它恢复。
    const backupDir = join(dataDir, SECRETS_BACKUP_DIR);
    const targets: { path: string; original: Buffer; plain: string; tmp: string }[] = [];
    const skipped: string[] = [];
    const sources = [encPath, ...backupFiles(dataDir).encrypted.map((f) => join(backupDir, f))];
    for (const path of sources) {
        const original = readFileSync(path);
        let plain: string;
        try {
            plain = decryptSecrets(original.toString('utf8'), oldKey);
        } catch {
            if (path === encPath) throw new SecretsMigrateError('verify_failed', 'the secrets file cannot be read');
            skipped.push(basename(path));
            continue;
        }
        targets.push({ path, original, plain, tmp: `${path}.rekey.tmp` });
    }

    const restoreOriginals = (): void => {
        for (const t of targets) {
            if (readFileSync(t.path).equals(t.original)) continue;
            writeFileAtomic(dirname(t.path), t.path, t.original.toString('utf8'));
            tighten(t.path);
        }
    };
    const cleanTmp = (): void => targets.forEach((t) => rmSync(t.tmp, { force: true }));
    const readBack = hooks?.readBack ?? ((p: string, k: Buffer) => decryptSecrets(readFileSync(p, 'utf8'), k));
    try {
        hooks?.beforeWrite?.();
        // 1. 全部写成临时文件并用新密钥回读比对;这一阶段没有任何正式文件被改动
        for (const t of targets) {
            rmSync(t.tmp, { force: true });
            writeFileSync(t.tmp, encryptSecrets(t.plain, newKey), { mode: 0o600, flag: 'wx' });
            let ok = false;
            try {
                const back = readBack(t.tmp, newKey);
                ok =
                    t.path === encPath
                        ? secretMapsEqual(values, parseSecretsFile(back))
                        : constantTimeEqual(back, t.plain);
            } catch {
                ok = false;
            }
            if (!ok) {
                throw new SecretsMigrateError(
                    'verify_failed',
                    'a re-encrypted copy did not match; nothing was changed',
                );
            }
        }
        // 2. 逐个改名;中途失败就把已换的恢复成原字节(主文件放最后,失败时它最可能还没动)
        const order = [...targets.filter((t) => t.path !== encPath), ...targets.filter((t) => t.path === encPath)];
        for (const t of order) {
            renameSync(t.tmp, t.path);
            tighten(t.path);
        }
    } catch (error) {
        cleanTmp();
        try {
            restoreOriginals();
        } catch {
            throw new SecretsMigrateError(
                'write_failed',
                `re-encrypting failed and some files could not be restored; the originals of ${SECRETS_ENC_FILE} and the backups are in ${SECRETS_BACKUP_DIR}/ only if their names still match`,
            );
        }
        if (error instanceof SecretsMigrateError) throw error;
        throw new SecretsMigrateError('write_failed', `cannot write ${SECRETS_ENC_FILE}: ${code(error)}`);
    }
    return {
        keys: values.size,
        fingerprint: keyFingerprint(newKey),
        backup,
        backupsRekeyed: targets.length - 1,
        backupsSkipped: skipped,
        rollback: restoreOriginals,
    };
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
