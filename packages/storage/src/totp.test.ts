// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { migrate } from './migrate.js';
import { migrations } from './migrations/index.js';
import { createRepositories } from './repos.js';
import { rekeyTotpSecrets, resetTotpOffline } from './totp.js';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';

let t: TestDb;
const clock = fakeClock();
beforeEach(async () => {
    t = await createTestDb({ now: clock.now });
});
afterEach(() => t.cleanup());

const codes = (n: number) => Array.from({ length: n }, (_, i) => ({ salt: `salt${i}`, codeHash: `hash${i}` }));
const session = (id: string, secondFactor = false) =>
    t.repos.authSessions.create({
        idHash: id,
        ownerId: t.ownerId,
        csrfHash: 'c',
        expiresAt: new Date(clock.now().getTime() + 100_000),
        secondFactor,
    });

describe('migration 0015', () => {
    it('applies on top of an existing database without touching data, and foreign_key_check is clean', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fatcat-m15-'));
        const conn = openDatabase(join(dir, 'db.sqlite'));
        try {
            await migrate(
                conn.sqlite,
                migrations.filter((m) => m.id <= 14),
                { backupDir: join(dir, 'backups') },
            );
            conn.sqlite
                .prepare(
                    "INSERT INTO owners (id, username, password_hash, created_at, updated_at) VALUES ('o','u','h','t','t')",
                )
                .run();
            conn.sqlite
                .prepare(
                    "INSERT INTO auth_sessions (id, owner_id, csrf_hash, created_at, expires_at, last_seen_at) VALUES ('s','o','c','t','t','t')",
                )
                .run();
            const result = await migrate(conn.sqlite, migrations, { backupDir: join(dir, 'backups') });
            expect(result.applied).toEqual([15]);
            expect(conn.sqlite.pragma('foreign_key_check')).toEqual([]);
            const row = conn.sqlite.prepare('SELECT id, second_factor_at AS f FROM auth_sessions').get();
            expect(row).toEqual({ id: 's', f: null });
            expect(createRepositories(conn).totp.get('o')).toBeNull();
        } finally {
            conn.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('totp repository', () => {
    it('a time step can be consumed once; the same or an earlier step is refused', () => {
        const { totp } = t.repos;
        expect(totp.saveSetup(t.ownerId, 'enc1')).toBe(true);
        expect(totp.consumeStep(t.ownerId, 10)).toBe(false); // not enabled yet
        session('s1');
        expect(totp.enable({ ownerId: t.ownerId, step: 100, codes: codes(10), keepSessionHash: 's1' })).toBe(true);
        expect(totp.consumeStep(t.ownerId, 100)).toBe(false);
        expect(totp.consumeStep(t.ownerId, 99)).toBe(false);
        expect(totp.consumeStep(t.ownerId, 101)).toBe(true);
        expect(totp.consumeStep(t.ownerId, 101)).toBe(false);
        expect(totp.get(t.ownerId)).toMatchObject({ enabled: true, lastUsedStep: 101, secretEnc: 'enc1' });
    });

    it('enable keeps only the current session (marked second factor) and stores the recovery codes', () => {
        const { totp, authSessions } = t.repos;
        session('keep');
        session('other');
        totp.saveSetup(t.ownerId, 'enc');
        expect(totp.enable({ ownerId: t.ownerId, step: 5, codes: codes(10), keepSessionHash: 'keep' })).toBe(true);
        expect(authSessions.getValid('other')).toBeNull();
        expect(authSessions.getValid('keep')?.secondFactorAt).not.toBeNull();
        expect(totp.recoveryCodesRemaining(t.ownerId)).toBe(10);
        // a second enable is a no-op, and setup cannot overwrite an enabled credential
        expect(totp.enable({ ownerId: t.ownerId, step: 9, codes: codes(10), keepSessionHash: 'keep' })).toBe(false);
        expect(totp.saveSetup(t.ownerId, 'evil')).toBe(false);
        expect(totp.get(t.ownerId)?.secretEnc).toBe('enc');
    });

    it('a recovery code works once; regenerating invalidates the old ones; disable removes everything', () => {
        const { totp } = t.repos;
        session('s');
        totp.saveSetup(t.ownerId, 'enc');
        totp.enable({ ownerId: t.ownerId, step: 1, codes: codes(10), keepSessionHash: 's' });
        const first = totp.unusedRecoveryCodes(t.ownerId)[0]!;
        expect(totp.useRecoveryCode(t.ownerId, first.id)).toBe(true);
        expect(totp.useRecoveryCode(t.ownerId, first.id)).toBe(false);
        expect(totp.recoveryCodesRemaining(t.ownerId)).toBe(9);

        totp.replaceRecoveryCodes(t.ownerId, codes(10));
        expect(totp.useRecoveryCode(t.ownerId, first.id)).toBe(false);
        expect(totp.recoveryCodesRemaining(t.ownerId)).toBe(10);

        session('x');
        totp.disable(t.ownerId, 's');
        expect(totp.get(t.ownerId)).toBeNull();
        expect(totp.recoveryCodesRemaining(t.ownerId)).toBe(0);
        expect(t.repos.authSessions.getValid('x')).toBeNull();
        expect(t.repos.authSessions.getValid('s')).not.toBeNull();
    });
});

describe('offline operations', () => {
    it('rekeyTotpSecrets rewraps every secret in one transaction and rolls back when the file step fails', () => {
        const { totp } = t.repos;
        totp.saveSetup(t.ownerId, 'old');
        expect(() =>
            rekeyTotpSecrets(
                t.conn,
                (e) => `new(${e})`,
                () => {
                    throw new Error('file step failed');
                },
            ),
        ).toThrow('file step failed');
        expect(totp.get(t.ownerId)?.secretEnc).toBe('old');

        const out = rekeyTotpSecrets(
            t.conn,
            (e) => `new(${e})`,
            () => 'done',
        );
        expect(out).toEqual({ result: 'done', rewrapped: 1 });
        expect(totp.get(t.ownerId)?.secretEnc).toBe('new(old)');
    });

    it('resetTotpOffline deletes credentials, codes and all sessions and writes an audit entry', () => {
        const { totp } = t.repos;
        session('a');
        session('b');
        totp.saveSetup(t.ownerId, 'enc');
        totp.enable({ ownerId: t.ownerId, step: 1, codes: codes(10), keepSessionHash: 'a' });
        expect(resetTotpOffline(t.conn, clock.now)).toEqual({ credentials: 1, sessions: 1 });
        expect(totp.get(t.ownerId)).toBeNull();
        expect(totp.recoveryCodesRemaining(t.ownerId)).toBe(0);
        expect(t.repos.authSessions.getValid('a')).toBeNull();
        const audit = t.conn.sqlite.prepare("SELECT summary FROM audit_log WHERE tool_name = 'auth.reset-totp'").all();
        expect(audit).toEqual([{ summary: 'TOTP 已本机重置' }]);
        expect(resetTotpOffline(t.conn, clock.now)).toEqual({ credentials: 0, sessions: 0 });
    });
});
