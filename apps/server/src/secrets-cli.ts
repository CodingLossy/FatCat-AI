// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 离线命令(ADR 0026):secrets migrate / rekey / cleanup。`apps/cli` 目前只是占位,所以命令放在服务器入口。
// 输出里只有键数、指纹与文件名,没有任何密钥值;不接受命令行形式的密钥。
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
    cleanupMigrated,
    encodeMasterKey,
    MasterKeyFormatError,
    migrateSecrets,
    parseMasterKey,
    rekeySecrets,
    restrictToCurrentUser,
    SECRETS_BACKUP_DIR,
    SECRETS_ENC_FILE,
    writeFileAtomic,
    SecretsMigrateError,
} from '@fatcat-ai/providers';
import { PlaintextBackupAction } from '@fatcat-ai/shared';
import { dataDirMasterKey, MASTER_KEY_FILE } from './data-dir.js';

export const SECRETS_USAGE = `Usage (stop the server first for migrate and rekey; neither checks whether it is running):
  secrets migrate [--plaintext-backups keep|encrypt|delete]
      Encrypt secrets.yaml into secrets.yaml.enc. The plaintext file is kept as secrets.yaml.migrated.
  secrets rekey --new-key-file <path>
      Re-encrypt secrets.yaml.enc under a new master key (64 hex characters or base64, in a file).
  secrets cleanup
      Delete secrets.yaml.migrated once you have confirmed the encrypted file works.
Keys are never accepted on the command line.`;

export interface SecretsCommandIo {
    dataDir: string;
    env: NodeJS.ProcessEnv;
    out: (line: string) => void;
    err: (line: string) => void;
    /** 测试用:替换 master.key.new → master.key 的改名(注入失败)。 */
    replaceMasterKey?: (from: string, to: string) => void;
}

/** 返回进程退出码。 */
export function runSecretsCommand(argv: readonly string[], io: SecretsCommandIo): number {
    const [command, ...rest] = argv;
    try {
        const keys = dataDirMasterKey(io.dataDir, io.env, (m) => io.err(`warning: ${m}`));
        keys.current(); // 环境变量里的主密钥格式不对时在这里报错
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
            // 2. 换密文(失败时 rekeySecrets 保留原文件;这里清掉暂存的新密钥)
            let r;
            try {
                r = rekeySecrets({ dataDir: io.dataDir, oldKey: current.key, newKey });
            } catch (error) {
                rmSync(staged, { force: true });
                throw error;
            }
            io.out(`Re-encrypted ${r.keys} key(s). New master key fingerprint: ${r.fingerprint}. Backup: ${r.backup}.`);
            // 3. 最后改名;失败时用刚做的备份把密文恢复成旧密钥的那份
            if (fromDataDir) {
                try {
                    (io.replaceMasterKey ?? renameSync)(staged, keyPath);
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code ?? 'error';
                    const backup = join(io.dataDir, SECRETS_BACKUP_DIR, r.backup);
                    try {
                        writeFileAtomic(io.dataDir, join(io.dataDir, SECRETS_ENC_FILE), readFileSync(backup, 'utf8'));
                        rmSync(staged, { force: true });
                        io.err(
                            `Error: could not replace ${MASTER_KEY_FILE} (${code}). ${SECRETS_ENC_FILE} was restored from the backup and still uses the old key; nothing else changed.`,
                        );
                    } catch {
                        io.err(
                            `Error: could not replace ${MASTER_KEY_FILE} (${code}), and restoring the backup failed too. ` +
                                `${SECRETS_ENC_FILE} now uses the NEW key. Move ${staged} to ${keyPath} (or point FATCAT_MASTER_KEY_FILE at ${file}), ` +
                                `or restore ${join(SECRETS_BACKUP_DIR, r.backup)} over ${SECRETS_ENC_FILE} to go back to the old key.`,
                        );
                    }
                    return 1;
                }
                restrictToCurrentUser(keyPath, { onWarning: (m) => io.err(`warning: ${m}`) });
                io.out(`${MASTER_KEY_FILE} was replaced with the new key.`);
            } else {
                io.out(
                    'The old key came from the environment: point FATCAT_MASTER_KEY or FATCAT_MASTER_KEY_FILE at the new key before starting the server.',
                );
            }
            io.out('Keys stored in the database (TOTP) are not re-encrypted by this command.');
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
