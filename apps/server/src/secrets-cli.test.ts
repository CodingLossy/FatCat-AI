// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSecretsCommand } from './secrets-cli.js';

describe('secrets commands', () => {
    let dir: string;
    let out: string[];
    let err: string[];
    const run = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
        runSecretsCommand(argv, { dataDir: dir, env, out: (l) => out.push(l), err: (l) => err.push(l) });
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
