// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSecretsCommand, type SecretsCommandIo } from './secrets-cli.js';

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
        expect(err.join('\n')).toMatch(/EBUSY.*restored from the backup.*old key/);
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
});
