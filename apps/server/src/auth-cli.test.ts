// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptSecrets, encryptSecrets, parseMasterKey } from '@fatcat-ai/providers';
import { createRepositories, openStorage } from '@fatcat-ai/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAuthCommand } from './auth-cli.js';
import { runSecretsCommand } from './secrets-cli.js';

const OLD_KEY = 'ab'.repeat(32);
const NEW_KEY = 'cd'.repeat(32);
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

let dir: string;
let out: string[];
let err: string[];
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fatcat-auth-cli-'));
    out = [];
    err = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 建一个已启用 TOTP 的数据目录:一个会话、一份用 OLD_KEY 加密的共享密钥、10 个恢复码。 */
async function seed() {
    const { conn } = await openStorage({ dataDir: dir });
    const repos = createRepositories(conn);
    const owner = repos.owners.create({ username: 'owner', passwordHash: 'x' });
    repos.authSessions.create({
        idHash: 's1',
        ownerId: owner.id,
        csrfHash: 'c',
        expiresAt: new Date(Date.now() + 1e6),
    });
    repos.totp.saveSetup(owner.id, encryptSecrets(SECRET, parseMasterKey(OLD_KEY)));
    repos.totp.enable({
        ownerId: owner.id,
        step: 1,
        codes: Array.from({ length: 10 }, (_, i) => ({ salt: `s${i}`, codeHash: `h${i}` })),
        keepSessionHash: 's1',
    });
    return { conn, repos, ownerId: owner.id };
}

describe('auth reset-totp', () => {
    it('removes the credential and recovery codes, signs everyone out and writes an audit entry', async () => {
        const { conn, repos, ownerId } = await seed();
        const code = runAuthCommand(['reset-totp'], { dataDir: dir, out: (l) => out.push(l), err: (l) => err.push(l) });
        expect(code).toBe(0);
        expect(repos.totp.get(ownerId)).toBeNull();
        expect(repos.totp.recoveryCodesRemaining(ownerId)).toBe(0);
        expect(repos.authSessions.getValid('s1')).toBeNull();
        const audit = conn.sqlite.prepare("SELECT summary FROM audit_log WHERE tool_name = 'auth.reset-totp'").all();
        expect(audit).toEqual([{ summary: 'TOTP 已本机重置' }]);
        conn.close();
        expect(runAuthCommand(['reset-totp'], { dataDir: dir, out: (l) => out.push(l), err: (l) => err.push(l) })).toBe(
            0,
        );
        expect(out.join('\n')).toContain('nothing was changed');
        expect(runAuthCommand(['nope'], { dataDir: dir, out: () => undefined, err: (l) => err.push(l) })).toBe(2);
    });
});

describe('secrets rekey with a TOTP secret in the database', () => {
    const run = (argv: string[], extra: Record<string, unknown> = {}) =>
        runSecretsCommand(argv, { dataDir: dir, env: {}, out: (l) => out.push(l), err: (l) => err.push(l), ...extra });

    it('re-encrypts the stored secret together with the key file and master.key', async () => {
        const { conn, repos, ownerId } = await seed();
        writeFileSync(join(dir, 'master.key'), `${OLD_KEY}\n`);
        writeFileSync(join(dir, 'secrets.yaml'), "MODEL_KEY: 'sk-test-0000000000'\n");
        expect(run(['migrate'])).toBe(0);
        writeFileSync(join(dir, 'new.key'), `${NEW_KEY}\n`);
        expect(run(['rekey', '--new-key-file', join(dir, 'new.key')])).toBe(0);
        const stored = repos.totp.get(ownerId)!.secretEnc;
        expect(decryptSecrets(stored, parseMasterKey(NEW_KEY))).toBe(SECRET);
        expect(() => decryptSecrets(stored, parseMasterKey(OLD_KEY))).toThrow();
        expect(out.join('\n')).toContain('1 TOTP secret');
        expect(out.join('\n') + err.join('\n')).not.toContain(SECRET);
        conn.close();
    });

    it('rolls the database back when master.key cannot be replaced', async () => {
        const { conn, repos, ownerId } = await seed();
        writeFileSync(join(dir, 'master.key'), `${OLD_KEY}\n`);
        writeFileSync(join(dir, 'secrets.yaml'), "MODEL_KEY: 'sk-test-0000000000'\n");
        expect(run(['migrate'])).toBe(0);
        const before = repos.totp.get(ownerId)!.secretEnc;
        writeFileSync(join(dir, 'new.key'), `${NEW_KEY}\n`);
        const code = run(['rekey', '--new-key-file', join(dir, 'new.key')], {
            replaceMasterKey: () => {
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            },
        });
        expect(code).toBe(1);
        expect(repos.totp.get(ownerId)!.secretEnc).toBe(before);
        conn.close();
    });
});
