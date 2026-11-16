// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptSecrets, encryptSecrets, parseMasterKey } from '@fatcat-ai/providers';
import { createRepositories, openStorage } from '@fatcat-ai/storage';
import { runSecretsCommand, type SecretsCommandIo } from './secrets-cli.js';
import { acquireServerLock, SERVER_LOCK_FILE } from './server-lock.js';

describe('secrets commands', () => {
    let dir: string;
    let out: string[];
    let err: string[];
    const run = (argv: string[], env: NodeJS.ProcessEnv = {}, extra: Partial<SecretsCommandIo> = {}) =>
        runSecretsCommand(argv, { dataDir: dir, env, out: (l) => out.push(l), err: (l) => err.push(l), ...extra });
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fatcat-cli-'));
        out = [];
        err = [];
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('migrate, rekey (master.key replaced) and cleanup, without printing any key', () => {
        writeFileSync(join(dir, 'secrets.yaml'), "MODEL_KEY: 'sk-test-cli-0000000000'\n");
        expect(run(['migrate'])).toBe(0);
        expect(existsSync(join(dir, 'secrets.yaml'))).toBe(false);
        const oldKey = readFileSync(join(dir, 'master.key'), 'utf8').trim();

        const newKeyFile = join(dir, 'new.key');
        const newKey = 'ab'.repeat(32);
        writeFileSync(newKeyFile, `${newKey}\n`);
        expect(run(['rekey', '--new-key-file', newKeyFile])).toBe(0);
        expect(readFileSync(join(dir, 'master.key'), 'utf8').trim()).toBe(newKey);
        expect(run(['cleanup'])).toBe(0);
        expect(existsSync(join(dir, 'secrets.yaml.migrated'))).toBe(false);

        const all = [...out, ...err].join('\n');
        expect(all).not.toContain('sk-test-cli');
        expect(all).not.toContain(oldKey);
        expect(all).not.toContain(newKey);
    });

    it('rekey: when master.key cannot be replaced, the ciphertext goes back to the old key and the message says so', () => {
        writeFileSync(join(dir, 'secrets.yaml'), "MODEL_KEY: 'sk-test-cli-0000000000'\n");
        expect(run(['migrate'])).toBe(0);
        const oldKey = readFileSync(join(dir, 'master.key'), 'utf8');
        const encBefore = readFileSync(join(dir, 'secrets.yaml.enc'));
        writeFileSync(join(dir, 'new.key'), `${'cd'.repeat(32)}\n`);
        out = [];
        err = [];
        const code = run(
            ['rekey', '--new-key-file', join(dir, 'new.key')],
            {},
            {
                replaceMasterKey: () => {
                    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
                },
            },
        );
        expect(code).toBe(1);
        expect(readFileSync(join(dir, 'master.key'), 'utf8')).toBe(oldKey);
        // 密文已恢复成旧密钥的那份:还能用旧密钥迁移后的流程读出来(cleanup 要求能解开)
        expect(run(['cleanup'])).toBe(0);
        expect(readFileSync(join(dir, 'secrets.yaml.enc'), 'utf8')).toMatch(/^fcsec1:/);
        expect(readFileSync(join(dir, 'secrets.yaml.enc')).length).toBe(encBefore.length);
        expect(existsSync(join(dir, 'master.key.new'))).toBe(false);
        expect(err.join('\n')).toMatch(/EBUSY.*restored.*old key/);
        expect(err.join('\n')).not.toContain('nothing was changed');
    });

    it('rekey: if the backup cannot be restored either, the message names the new key file and the backup', () => {
        writeFileSync(join(dir, 'secrets.yaml'), "MODEL_KEY: 'sk-test-cli-0000000000'\n");
        expect(run(['migrate'])).toBe(0);
        writeFileSync(join(dir, 'new.key'), `${'cd'.repeat(32)}\n`);
        err = [];
        const code = run(
            ['rekey', '--new-key-file', join(dir, 'new.key')],
            {},
            {
                replaceMasterKey: () => {
                    // 改名失败的同时备份也没了
                    rmSync(join(dir, 'backups'), { recursive: true, force: true });
                    throw Object.assign(new Error('denied'), { code: 'EACCES' });
                },
            },
        );
        expect(code).toBe(1);
        const text = err.join('\n');
        expect(text).toContain('NEW key');
        expect(text).toContain('master.key.new');
        expect(text).toContain('new.key');
        expect(existsSync(join(dir, 'master.key.new'))).toBe(true); // 新密钥文件留着,可手工改名
    });

    it('refuses keys on the command line, unknown commands, and a malformed environment key', () => {
        expect(run(['rekey', '--new-key', 'ab'.repeat(32)])).toBe(2);
        expect(run(['rekey'])).toBe(2);
        expect(run(['migrate', '--plaintext-backups', 'wipe'])).toBe(2);
        expect(run(['bogus'])).toBe(2);
        expect(run(['migrate'], { FATCAT_MASTER_KEY: 'not-a-key' })).toBe(1);
        expect(existsSync(join(dir, 'master.key'))).toBe(false);
        expect(err.join('\n')).not.toContain('ab'.repeat(32));
    });

    it('migrate and rekey refuse while the server lock is held, and leave every file byte-identical', () => {
        writeFileSync(join(dir, 'secrets.yaml'), "MODEL_KEY: 'sk-test-cli-0000000000'\n");
        const snapshot = () =>
            readdirSync(dir)
                .sort()
                .map((f) => [f, existsSync(join(dir, f)) ? readFileSync(join(dir, f)).toString('hex') : '']);
        // 本进程的 pid 不算「另一个服务器」,所以用一个假的存活 pid
        writeFileSync(join(dir, SERVER_LOCK_FILE), `${JSON.stringify({ pid: 424242 })}\n`);
        const before = snapshot();
        const alive = { processAlive: () => true };
        expect(run(['migrate'], {}, alive)).toBe(1);
        expect(err.join('\n')).toMatch(/server seems to be running.*Nothing was changed/s);
        writeFileSync(join(dir, 'new.key'), `${'cd'.repeat(32)}\n`);
        const withKey = snapshot();
        expect(run(['rekey', '--new-key-file', join(dir, 'new.key')], {}, alive)).toBe(1);
        expect(snapshot()).toEqual(withKey);
        expect(before.length).toBeGreaterThan(0);
        expect(existsSync(join(dir, 'secrets.yaml.enc'))).toBe(false);
        expect(existsSync(join(dir, 'master.key'))).toBe(false);
        // 进程已经不在(过期的锁):照常执行
        expect(run(['migrate'], {}, { processAlive: () => false })).toBe(0);
    });

    it('the lock written by the server is removed on release and only by its owner', () => {
        const release = acquireServerLock(dir, 31337);
        expect(readFileSync(join(dir, SERVER_LOCK_FILE), 'utf8')).toContain('31337');
        writeFileSync(join(dir, SERVER_LOCK_FILE), `${JSON.stringify({ pid: 99999 })}\n`); // 别人接管了
        release();
        expect(existsSync(join(dir, SERVER_LOCK_FILE))).toBe(true);
        const again = acquireServerLock(dir, 31337);
        again();
        expect(existsSync(join(dir, SERVER_LOCK_FILE))).toBe(false);
    });

    it('rekey with a plaintext secrets.yaml re-encrypts only the TOTP secret in the database', async () => {
        writeFileSync(join(dir, 'secrets.yaml'), "MODEL_KEY: 'sk-test-cli-0000000000'\n");
        const oldHex = 'ab'.repeat(32);
        const newHex = 'cd'.repeat(32);
        const env = { FATCAT_MASTER_KEY: oldHex };
        const { conn } = await openStorage({ dataDir: dir });
        const repos = createRepositories(conn);
        const owner = repos.owners.create({ username: 'owner', passwordHash: 'x' });
        expect(repos.totp.saveSetup(owner.id, encryptSecrets('JBSWY3DPEHPK3PXP', parseMasterKey(oldHex)))).toBe(true);
        conn.close();
        writeFileSync(join(dir, 'new.key'), `${newHex}\n`);
        const plaintext = readFileSync(join(dir, 'secrets.yaml'));
        expect(run(['rekey', '--new-key-file', join(dir, 'new.key')], env)).toBe(0);
        expect(out.join('\n')).toContain('Re-encrypted 1 TOTP secret');
        expect(out.join('\n')).toContain('still plaintext');
        expect(readFileSync(join(dir, 'secrets.yaml')).equals(plaintext)).toBe(true);
        const again = await openStorage({ dataDir: dir });
        const row = again.conn.sqlite.prepare('SELECT secret_enc AS e FROM totp_credentials').get() as { e: string };
        again.conn.close();
        expect(decryptSecrets(row.e, parseMasterKey(newHex))).toBe('JBSWY3DPEHPK3PXP');
        // 没有 TOTP 也没有加密文件:仍然报错
        const empty = mkdtempSync(join(tmpdir(), 'fatcat-cli-'));
        writeFileSync(join(empty, 'secrets.yaml'), "MODEL_KEY: 'x'\n");
        const code = runSecretsCommand(['rekey', '--new-key-file', join(dir, 'new.key')], {
            dataDir: empty,
            env,
            out: () => undefined,
            err: () => undefined,
        });
        rmSync(empty, { recursive: true, force: true });
        expect(code).toBe(1);
    });

    it('rekey re-encrypts the encrypted backups and its printed Backup file opens with the new key', () => {
        writeFileSync(join(dir, 'secrets.yaml'), "MODEL_KEY: 'sk-test-cli-0000000000'\n");
        expect(run(['migrate', '--plaintext-backups', 'encrypt'])).toBe(0);
        writeFileSync(join(dir, 'new.key'), `${'ef'.repeat(32)}\n`);
        out = [];
        expect(run(['rekey', '--new-key-file', join(dir, 'new.key')])).toBe(0);
        const backup = /Backup: ([^\s.]+[^\s]*?)\.\s/.exec(out.join('\n'))![1]!;
        const newKey = parseMasterKey('ef'.repeat(32));
        for (const f of [backup, ...readdirSync(join(dir, 'backups')).filter((n) => n.endsWith('.enc'))]) {
            const path = f === backup ? join(dir, 'backups', f) : join(dir, 'backups', f);
            expect(decryptSecrets(readFileSync(path, 'utf8'), newKey)).toContain('MODEL_KEY');
        }
    });
});
