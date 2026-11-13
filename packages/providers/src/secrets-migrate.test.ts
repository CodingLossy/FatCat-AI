// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redactor } from './redact.js';
import {
    createMasterKeyResolver,
    decryptSecrets,
    encodeMasterKey,
    SecretsKeyUnavailableError,
} from './secrets-crypto.js';
import {
    cleanupMigrated,
    migrateSecrets,
    readSecretsStatus,
    rekeySecrets,
    SecretsMigrateError,
} from './secrets-migrate.js';
import { SecretsLayoutError, SecretStore } from './secrets.js';

const PLAIN = '# keys\nDEEPSEEK_API_KEY: \'sk-test-aaaaaaaaaaaaaaaa\'\nILINK_TOKEN_A: "tok-bbbbbbbbbbbb"\n';
const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);
const at = (s: number) => new Date(Date.UTC(2026, 10, 13, 9, 0, s));

describe('secrets migration and file states', () => {
    let dir: string;
    let masterKeyFile: string | null; // 模拟 master.key
    const plain = () => join(dir, 'secrets.yaml');
    const enc = () => join(dir, 'secrets.yaml.enc');
    const names = () => readdirSync(dir).sort();
    const backupDir = () => join(dir, 'backups');
    const keys = (env: NodeJS.ProcessEnv = {}) =>
        createMasterKeyResolver({
            env,
            readDataDirKey: () => masterKeyFile,
            createDataDirKey: (k) => {
                masterKeyFile = encodeMasterKey(k);
            },
        });
    const store = (k = keys()) => new SecretStore({ dataDir: dir, env: {}, redactor: new Redactor(), masterKey: k });

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fatcat-migrate-'));
        masterKeyFile = encodeMasterKey(KEY_A);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    describe('four file states', () => {
        it('none: the first write goes straight to secrets.yaml.enc and creates the master key', () => {
            masterKeyFile = null;
            const s = store();
            s.write('ILINK_TOKEN_A', 'tok-first-0000', at(0));
            expect(existsSync(plain())).toBe(false);
            expect(readFileSync(enc(), 'utf8')).not.toContain('tok-first');
            expect(masterKeyFile).not.toBeNull();
            expect(s.resolve('file:ILINK_TOKEN_A')).toBe('tok-first-0000');
            expect(readSecretsStatus(dir, keys())).toMatchObject({ file: 'encrypted', keyAvailable: true });
        });

        it('plaintext: read and written as plaintext until the user migrates; nothing is created', () => {
            writeFileSync(plain(), PLAIN);
            masterKeyFile = null;
            const s = store();
            expect(s.resolve('file:DEEPSEEK_API_KEY')).toBe('sk-test-aaaaaaaaaaaaaaaa');
            s.write('NEW_KEY', 'value-12345', at(0));
            expect(readFileSync(plain(), 'utf8')).toContain("NEW_KEY: 'value-12345'");
            expect(existsSync(enc())).toBe(false);
            expect(masterKeyFile).toBeNull();
            expect(readSecretsStatus(dir, keys())).toMatchObject({ file: 'plaintext', masterKeySource: 'none' });
        });

        it('encrypted: reads, writes only the target key, and backs up the envelope byte for byte', () => {
            const s = store();
            s.write('A_KEY', 'aaaa-1111', at(0));
            s.write('B_KEY', 'bbbb-2222', at(1));
            const before = readFileSync(enc(), 'utf8');
            s.write('B_KEY', 'bbbb-3333', at(2));
            expect(s.resolve('file:A_KEY')).toBe('aaaa-1111');
            expect(s.resolve('file:B_KEY')).toBe('bbbb-3333');
            const backups = readdirSync(backupDir()).sort();
            expect(backups).toEqual(['secrets-20261113T090001Z.yaml.enc', 'secrets-20261113T090002Z.yaml.enc']);
            expect(readFileSync(join(backupDir(), 'secrets-20261113T090002Z.yaml.enc'), 'utf8')).toBe(before);
            expect(decryptSecrets(readFileSync(enc(), 'utf8'), KEY_A)).toBe("A_KEY: 'aaaa-1111'\nB_KEY: 'bbbb-3333'\n");
        });

        it('encrypted: refuses to write when the decrypted content does not parse', () => {
            writeFileSync(enc(), `${JSON.stringify('x')}`);
            const s = store();
            expect(() => s.write('A', 'value-1', at(0))).toThrow();
            expect(readFileSync(enc(), 'utf8')).toBe('"x"');
        });

        it('both files present: startup check reports it and no file is touched', () => {
            writeFileSync(plain(), PLAIN);
            writeFileSync(enc(), 'fcsec1:a:b:c');
            const s = store();
            expect(() => s.checkLayout()).toThrow(SecretsLayoutError);
            expect(() => s.write('A', 'value-1')).toThrow(SecretsLayoutError);
            expect(readFileSync(plain(), 'utf8')).toBe(PLAIN);
            expect(readFileSync(enc(), 'utf8')).toBe('fcsec1:a:b:c');
        });

        it('missing or wrong master key: reads fail with key-unavailable and the file is never changed', () => {
            store().write('A_KEY', 'aaaa-1111', at(0));
            const bytes = readFileSync(enc());
            for (const key of [null, encodeMasterKey(KEY_B)]) {
                masterKeyFile = key;
                const s = store();
                expect(() => s.resolve('file:A_KEY')).toThrow(SecretsKeyUnavailableError);
                expect(s.status('file:A_KEY')).toBe('missing');
                expect(() => s.write('B_KEY', 'bbbb-2222')).toThrow(SecretsKeyUnavailableError);
                expect(() => s.remove('A_KEY')).toThrow(SecretsKeyUnavailableError);
                expect(readSecretsStatus(dir, keys())).toMatchObject({ file: 'encrypted', keyAvailable: false });
                expect(readFileSync(enc()).equals(bytes)).toBe(true);
            }
            expect(names()).not.toContain('master.key.tmp');
            expect(masterKeyFile).toBe(encodeMasterKey(KEY_B)); // 没有生成新的主密钥
        });

        it('an environment key overrides master.key', () => {
            store(keys({ FATCAT_MASTER_KEY: KEY_B.toString('hex') })).write('A_KEY', 'aaaa-1111', at(0));
            expect(() => store(keys()).resolve('file:A_KEY')).toThrow(SecretsKeyUnavailableError);
            expect(store(keys({ FATCAT_MASTER_KEY: KEY_B.toString('hex') })).resolve('file:A_KEY')).toBe('aaaa-1111');
        });
    });

    describe('migrateSecrets', () => {
        it('backs up, encrypts, verifies, then renames the plaintext to secrets.yaml.migrated', () => {
            writeFileSync(plain(), PLAIN);
            const result = migrateSecrets({ dataDir: dir, keys: keys(), now: at(0) });
            expect(result).toMatchObject({ migratedKeys: 2, backup: 'secrets-20261113T090000Z.yaml' });
            expect(result.plaintextBackups).toEqual({ kept: 1, encrypted: 0, deleted: 0 });
            expect(existsSync(plain())).toBe(false);
            expect(readFileSync(join(dir, 'secrets.yaml.migrated'), 'utf8')).toBe(PLAIN);
            expect(names()).not.toContain('secrets.yaml.enc.tmp');
            expect(readFileSync(enc(), 'utf8')).not.toContain('sk-test');
            expect(decryptSecrets(readFileSync(enc(), 'utf8'), KEY_A)).toBe(PLAIN);
            expect(store().resolve('file:ILINK_TOKEN_A')).toBe('tok-bbbbbbbbbbbb');
            expect(JSON.stringify(result)).not.toContain('sk-test');
        });

        it('leaves the plaintext bytes unchanged when the read-back differs, and can be repeated', () => {
            writeFileSync(plain(), PLAIN);
            const wrong = () =>
                migrateSecrets({
                    dataDir: dir,
                    keys: keys(),
                    now: at(0),
                    hooks: {
                        readBack: () =>
                            "DEEPSEEK_API_KEY: 'sk-test-aaaaaaaaaaaaaaaX'\nILINK_TOKEN_A: 'tok-bbbbbbbbbbbb'\n",
                    },
                });
            expect(wrong).toThrow(SecretsMigrateError);
            expect(readFileSync(plain(), 'utf8')).toBe(PLAIN);
            expect(existsSync(enc())).toBe(false);
            expect(names().filter((n) => n.includes('tmp'))).toEqual([]);
            // 第二次(没有故障)成功
            expect(migrateSecrets({ dataDir: dir, keys: keys(), now: at(1) }).migratedKeys).toBe(2);
            expect(existsSync(plain())).toBe(false);
        });

        it('leaves the plaintext bytes unchanged when writing fails (simulated read-only directory)', () => {
            writeFileSync(plain(), PLAIN);
            const fail = () =>
                migrateSecrets({
                    dataDir: dir,
                    keys: keys(),
                    hooks: {
                        beforeWrite: () => {
                            throw Object.assign(new Error('denied'), { code: 'EACCES' });
                        },
                    },
                });
            expect(fail).toThrow(/EACCES/);
            expect(readFileSync(plain(), 'utf8')).toBe(PLAIN);
            expect(existsSync(enc())).toBe(false);
            expect(existsSync(join(dir, 'secrets.yaml.enc.tmp'))).toBe(false);
        });

        it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
            'leaves the plaintext unchanged in a really read-only data directory',
            () => {
                writeFileSync(plain(), PLAIN);
                mkdirSync(backupDir());
                chmodSync(dir, 0o500);
                try {
                    expect(() => migrateSecrets({ dataDir: dir, keys: keys() })).toThrow(SecretsMigrateError);
                } finally {
                    chmodSync(dir, 0o700);
                }
                expect(readFileSync(plain(), 'utf8')).toBe(PLAIN);
                expect(existsSync(enc())).toBe(false);
            },
        );

        it('refuses to guess: unparsable plaintext, nothing to migrate, already encrypted', () => {
            expect(() => migrateSecrets({ dataDir: dir, keys: keys() })).toThrow(/no secrets file/);
            writeFileSync(plain(), 'not a mapping\n');
            expect(() => migrateSecrets({ dataDir: dir, keys: keys() })).toThrow(SecretsMigrateError);
            expect(readFileSync(plain(), 'utf8')).toBe('not a mapping\n');
            rmSync(plain());
            store().write('A_KEY', 'aaaa-1111');
            expect(() => migrateSecrets({ dataDir: dir, keys: keys() })).toThrow(/already encrypted/);
        });

        it('finishes an interrupted migration when the encrypted copy matches, and refuses when it differs', () => {
            writeFileSync(plain(), PLAIN);
            migrateSecrets({ dataDir: dir, keys: keys(), now: at(0) });
            // 模拟中断:明文被放回来,密文还在
            writeFileSync(plain(), PLAIN);
            expect(() => store().checkLayout()).toThrow(SecretsLayoutError);
            const done = migrateSecrets({ dataDir: dir, keys: keys(), now: at(1) });
            expect(done.migratedKeys).toBe(2);
            expect(existsSync(plain())).toBe(false);
            expect(names()).toContain('secrets.yaml.migrated.2'); // 不覆盖上一份
            // 不一致:报错,两个文件都不动
            writeFileSync(plain(), "OTHER: 'zzzzzzzzzz'\n");
            const encBytes = readFileSync(enc());
            expect(() => migrateSecrets({ dataDir: dir, keys: keys() })).toThrow(/differ/);
            expect(readFileSync(plain(), 'utf8')).toBe("OTHER: 'zzzzzzzzzz'\n");
            expect(readFileSync(enc()).equals(encBytes)).toBe(true);
        });

        describe('plaintext backups', () => {
            beforeEach(() => {
                mkdirSync(backupDir());
                writeFileSync(join(backupDir(), 'secrets-20260101T000000Z.yaml'), PLAIN);
                writeFileSync(join(backupDir(), 'secrets-20260102T000000Z.yaml'), PLAIN);
                writeFileSync(plain(), PLAIN);
            });
            const list = () => readdirSync(backupDir()).sort();

            it('keep (default) leaves them alone', () => {
                const r = migrateSecrets({ dataDir: dir, keys: keys(), now: at(0) });
                expect(r.plaintextBackups).toEqual({ kept: 3, encrypted: 0, deleted: 0 });
                expect(list()).toHaveLength(3);
                expect(readSecretsStatus(dir, keys()).backups).toEqual({ total: 3, plaintext: 3 });
            });

            it('encrypt turns each into a .enc file and removes the plaintext copy', () => {
                const r = migrateSecrets({ dataDir: dir, keys: keys(), now: at(0), plaintextBackups: 'encrypt' });
                expect(r.plaintextBackups).toEqual({ kept: 0, encrypted: 3, deleted: 0 });
                expect(r.backup).toBe('secrets-20261113T090000Z.yaml.enc');
                expect(list().every((f) => f.endsWith('.yaml.enc'))).toBe(true);
                for (const f of list()) {
                    const text = readFileSync(join(backupDir(), f), 'utf8');
                    expect(text).not.toContain('sk-test');
                    expect(decryptSecrets(text, KEY_A)).toBe(PLAIN);
                }
                expect(readSecretsStatus(dir, keys()).backups).toEqual({ total: 3, plaintext: 0 });
            });

            it('delete removes them', () => {
                const r = migrateSecrets({ dataDir: dir, keys: keys(), now: at(0), plaintextBackups: 'delete' });
                expect(r.plaintextBackups).toEqual({ kept: 0, encrypted: 0, deleted: 3 });
                expect(list()).toEqual([]);
                expect(existsSync(join(dir, 'secrets.yaml.migrated'))).toBe(true); // 回滚用的副本仍在
            });
        });
    });

    describe('rekeySecrets and cleanup', () => {
        it('re-encrypts under the new key after backing up the old envelope, and the old key stops working', () => {
            const s = store();
            s.write('A_KEY', 'aaaa-1111', at(0));
            const old = readFileSync(enc(), 'utf8');
            const r = rekeySecrets({ dataDir: dir, oldKey: KEY_A, newKey: KEY_B, now: at(1) });
            expect(r.keys).toBe(1);
            expect(readFileSync(join(backupDir(), r.backup), 'utf8')).toBe(old);
            expect(decryptSecrets(readFileSync(enc(), 'utf8'), KEY_B)).toBe("A_KEY: 'aaaa-1111'\n");
            expect(() => decryptSecrets(readFileSync(enc(), 'utf8'), KEY_A)).toThrow(SecretsKeyUnavailableError);
            expect(existsSync(join(dir, 'secrets.yaml.enc.tmp'))).toBe(false);
        });

        it('keeps the file when the old key is wrong or the read-back differs', () => {
            store().write('A_KEY', 'aaaa-1111', at(0));
            const bytes = readFileSync(enc());
            expect(() => rekeySecrets({ dataDir: dir, oldKey: KEY_B, newKey: KEY_B })).toThrow(SecretsMigrateError);
            expect(() =>
                rekeySecrets({ dataDir: dir, oldKey: KEY_A, newKey: KEY_B, hooks: { readBack: () => "A_KEY: 'x'\n" } }),
            ).toThrow(/did not match/);
            expect(readFileSync(enc()).equals(bytes)).toBe(true);
            expect(existsSync(join(dir, 'secrets.yaml.enc.tmp'))).toBe(false);
        });

        it('cleanup removes secrets.yaml.migrated only while the encrypted file works', () => {
            writeFileSync(plain(), PLAIN);
            migrateSecrets({ dataDir: dir, keys: keys(), now: at(0) });
            masterKeyFile = encodeMasterKey(KEY_B);
            expect(() => cleanupMigrated(dir, keys())).toThrow(SecretsMigrateError);
            expect(existsSync(join(dir, 'secrets.yaml.migrated'))).toBe(true);
            masterKeyFile = encodeMasterKey(KEY_A);
            expect(cleanupMigrated(dir, keys())).toBe(1);
            expect(existsSync(join(dir, 'secrets.yaml.migrated'))).toBe(false);
            expect(cleanupMigrated(dir, keys())).toBe(0);
        });
    });
});
