// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 离线命令(ADR 0026):secrets migrate / rekey / cleanup。`apps/cli` 目前只是占位,所以命令放在服务器入口。
// 输出里只有键数、指纹与文件名,没有任何密钥值;不接受命令行形式的密钥。
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
    cleanupMigrated,
    decryptSecrets,
    encodeMasterKey,
    encryptSecrets,
    MasterKeyFormatError,
    migrateSecrets,
    parseMasterKey,
    rekeySecrets,
    restrictToCurrentUser,
    secretsLayout,
    SECRETS_BACKUP_DIR,
    SECRETS_ENC_FILE,
    SecretsMigrateError,
} from '@fatcat-ai/providers';
import { PlaintextBackupAction } from '@fatcat-ai/shared';
import { openDatabase, rekeyTotpSecrets } from '@fatcat-ai/storage';
import { dataDirMasterKey, MASTER_KEY_FILE } from './data-dir.js';
import { runningServerPid, SERVER_LOCK_FILE } from './server-lock.js';

export const SECRETS_USAGE = `Usage (stop the server first: migrate and rekey refuse to run while the server's lock file is held):
  secrets migrate [--plaintext-backups keep|encrypt|delete]
      Encrypt secrets.yaml into secrets.yaml.enc. The plaintext file is kept as secrets.yaml.migrated.
  secrets rekey --new-key-file <path>
      Re-encrypt secrets.yaml.enc, every encrypted backup in backups/, and the TOTP secret stored in the
      database under a new master key (64 hex characters or base64, in a file); all of it succeeds or none of it.
  secrets cleanup
      Delete secrets.yaml.migrated once you have confirmed the encrypted file works.
Keys are never accepted on the command line.`;

export interface SecretsCommandIo {
    dataDir: string;
    env: NodeJS.ProcessEnv;
    out: (line: string) => void;
    err: (line: string) => void;
    /** 测试用:替换「进程是否还在」的判断。 */
    processAlive?: (pid: number) => boolean;
    /** 测试用:替换 master.key.new → master.key 的改名(注入失败)。 */
    replaceMasterKey?: (from: string, to: string) => void;
}

/** 返回进程退出码。 */
export function runSecretsCommand(argv: readonly string[], io: SecretsCommandIo): number {
    const [command, ...rest] = argv;
    try {
        const keys = dataDirMasterKey(io.dataDir, io.env, (m) => io.err(`warning: ${m}`));
        keys.current(); // 环境变量里的主密钥格式不对时在这里报错
        if (command === 'migrate' || command === 'rekey') {
            // 服务器在读入与改名之间写入新的令牌会被静默丢掉:有运行中的服务器就什么都不改
            const pid = runningServerPid(io.dataDir, io.processAlive);
            if (pid !== null) {
                io.err(
                    `Error: the server seems to be running (process ${pid}, see ${SERVER_LOCK_FILE} in the data directory). ` +
                        `Stop it first, then run "secrets ${command}" again. Nothing was changed. ` +
                        `If the server is already stopped (for example a stale ${SERVER_LOCK_FILE} left in a Docker volume), ` +
                        `confirm the server has stopped and then delete ${SERVER_LOCK_FILE} / 确认服务器已停止后删除 ${SERVER_LOCK_FILE}。`,
                );
                return 1;
            }
        }
        if (command === 'migrate') {
            const opts = parseOptions(rest, ['--plaintext-backups']);
            const mode = PlaintextBackupAction.safeParse(opts['--plaintext-backups'] ?? 'keep');
            if (!mode.success) return usage(io, '--plaintext-backups must be keep, encrypt or delete');
            const r = migrateSecrets({ dataDir: io.dataDir, keys, plaintextBackups: mode.data });
            io.out(`Encrypted ${r.migratedKeys} key(s). Master key fingerprint: ${r.fingerprint}.`);
            io.out(`Backup: ${r.backup}. Plaintext backups: ${JSON.stringify(r.plaintextBackups)}.`);
            io.out(
                'The old plaintext file is now secrets.yaml.migrated. Check that the server works, then run "secrets cleanup".',
            );
            return 0;
        }
        if (command === 'rekey') {
            const opts = parseOptions(rest, ['--new-key-file']);
            const file = opts['--new-key-file'];
            if (!file) return usage(io, 'rekey needs --new-key-file <path>');
            const current = keys.current();
            if (!current.key) {
                io.err(
                    'The current master key is not usable, so the file cannot be re-encrypted. Nothing was changed.',
                );
                return 1;
            }
            const newKey = parseMasterKey(readFileSync(file, 'utf8'), 'The new key file');
            const keyPath = join(io.dataDir, MASTER_KEY_FILE);
            const staged = `${keyPath}.new`;
            const fromDataDir = current.source === 'data-dir';
            // 1. 先把新密钥写成 master.key.new 并 fsync;这一步失败时密文还没动
            if (fromDataDir) {
                try {
                    rmSync(staged, { force: true });
                    const fd = openSync(staged, 'wx', 0o600);
                    try {
                        writeSync(fd, `${encodeMasterKey(newKey)}\n`);
                        fsyncSync(fd);
                    } finally {
                        closeSync(fd);
                    }
                } catch (error) {
                    rmSync(staged, { force: true });
                    io.err(
                        `Error: cannot stage the new master key (${(error as NodeJS.ErrnoException).code ?? 'error'}). Nothing was changed.`,
                    );
                    return 1;
                }
            }
            // 2. 库内 TOTP 共享密钥与密钥文件同一个数据库事务:换密文、改名 master.key 任何一步失败(且已恢复旧密文)时,
            //    库里的信封一并回滚;只有「恢复备份也失败」时文件已是新密钥,库里随之提交新信封,保持一致
            const dbPath = join(io.dataDir, 'db.sqlite');
            const conn = existsSync(dbPath) ? openDatabase(dbPath) : null;
            // 没有加密文件(没有 secrets 文件,或还是明文)时只重新加密库里的 TOTP 密钥;明文与密文并存仍然报错
            const layout = secretsLayout(io.dataDir);
            const noFile = layout === 'none' || layout === 'plaintext';
            let rekeyed: ReturnType<typeof rekeySecrets> | null = null;
            let renamed = !fromDataDir;
            let restoreFailed = false;
            const move = (): void => {
                // 3. 最后改名;失败时用刚做的备份把密文恢复成旧密钥的那份
                if (!fromDataDir) return;
                try {
                    (io.replaceMasterKey ?? renameSync)(staged, keyPath);
                    renamed = true;
                } catch (error) {
                    const errCode = (error as NodeJS.ErrnoException).code ?? 'error';
                    if (!rekeyed) {
                        // 没有密钥文件要恢复:库里的信封随事务回滚即回到旧密钥
                        io.err(
                            `Error: could not replace ${MASTER_KEY_FILE} (${errCode}). The TOTP secrets in the database were rolled back and still use the old key; nothing else changed.`,
                        );
                        throw new RekeyAborted();
                    }
                    try {
                        // 主文件和所有加密备份一起恢复成换钥前的字节
                        rekeyed.rollback();
                        rmSync(staged, { force: true });
                        io.err(
                            `Error: could not replace ${MASTER_KEY_FILE} (${errCode}). ${SECRETS_ENC_FILE} and its backups were restored and still use the old key; nothing else changed.`,
                        );
                    } catch {
                        restoreFailed = true;
                        io.err(
                            `Error: could not replace ${MASTER_KEY_FILE} (${errCode}), and restoring the old-key copies failed too. ` +
                                `${SECRETS_ENC_FILE} now uses the NEW key. Move ${staged} to ${keyPath} (or point FATCAT_MASTER_KEY_FILE at ${file}), ` +
                                `the encrypted backups in ${SECRETS_BACKUP_DIR}/ may use the NEW key as well, so keep the new key file.`,
                        );
                    }
                    if (!restoreFailed) throw new RekeyAborted();
                }
            };
            let rewrapped = 0;
            try {
                const rewrap = (envelope: string) => {
                    rewrapped++;
                    return encryptSecrets(decryptSecrets(envelope, current.key!), newKey);
                };
                const during = () => {
                    // 失败时 rekeySecrets 保留原文件;外层清掉暂存的新密钥
                    if (!noFile) rekeyed = rekeySecrets({ dataDir: io.dataDir, oldKey: current.key!, newKey });
                    else if (rewrapped === 0) {
                        throw new SecretsMigrateError(
                            'not_encrypted',
                            'there is no encrypted secrets file to re-encrypt',
                        );
                    }
                    move();
                };
                if (conn) rekeyTotpSecrets(conn, rewrap, during);
                else during();
            } catch (error) {
                if (!restoreFailed) rmSync(staged, { force: true });
                if (error instanceof RekeyAborted) return 1;
                throw error;
            } finally {
                conn?.close();
            }
            if (rekeyed) {
                const r = rekeyed as ReturnType<typeof rekeySecrets>;
                io.out(
                    `Re-encrypted ${r.keys} key(s). New master key fingerprint: ${r.fingerprint}. Backup: ${r.backup}.`,
                );
                io.out(`Re-encrypted ${r.backupsRekeyed} backup(s) in ${SECRETS_BACKUP_DIR}/ with the new key.`);
                if (r.backupsSkipped.length > 0) {
                    io.err(
                        `warning: ${r.backupsSkipped.length} backup(s) could not be opened with the old key and were left as they are: ${r.backupsSkipped.join(', ')}`,
                    );
                }
            }
            io.out(`Re-encrypted ${rewrapped} TOTP secret(s) in the database.`);
            if (layout === 'plaintext') {
                io.out(
                    'secrets.yaml is still plaintext, so there was no file to re-encrypt; run "secrets migrate" to encrypt it.',
                );
            }
            if (restoreFailed) return 1;
            if (fromDataDir && renamed) {
                restrictToCurrentUser(keyPath, { onWarning: (m) => io.err(`warning: ${m}`) });
                io.out(`${MASTER_KEY_FILE} was replaced with the new key.`);
            } else {
                io.out(
                    'The old key came from the environment: point FATCAT_MASTER_KEY or FATCAT_MASTER_KEY_FILE at the new key before starting the server.',
                );
            }
            return 0;
        }
        if (command === 'cleanup') {
            parseOptions(rest, []);
            const n = cleanupMigrated(io.dataDir, keys);
            io.out(n === 0 ? 'Nothing to clean up.' : `Deleted ${n} secrets.yaml.migrated file(s).`);
            return 0;
        }
        return usage(io, command ? `unknown command "${command}"` : 'a command is required');
    } catch (error) {
        if (error instanceof UsageError) return usage(io, error.message);
        if (error instanceof SecretsMigrateError || error instanceof MasterKeyFormatError) {
            io.err(`Error: ${error.message}`);
            return 1;
        }
        io.err(
            `Error: ${(error as NodeJS.ErrnoException).code ?? 'unexpected failure'} (see the message above for what was changed)`,
        );
        return 1;
    }
}

class UsageError extends Error {}

/** 改名失败且已恢复旧密文:让数据库事务回滚;错误信息已经输出。 */
class RekeyAborted extends Error {}

function usage(io: SecretsCommandIo, problem: string): number {
    io.err(`${problem}\n${SECRETS_USAGE}`);
    return 2;
}

/** 只接受列出的 `--name value` 选项;其他一律报错(尤其是把密钥写在命令行上)。 */
function parseOptions(args: readonly string[], allowed: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
        const name = args[i]!;
        const value = args[i + 1];
        if (!allowed.includes(name) || value === undefined || value.startsWith('--')) {
            throw new UsageError(`unexpected argument "${name.startsWith('--') ? name : '…'}"`);
        }
        out[name] = value;
    }
    return out;
}
