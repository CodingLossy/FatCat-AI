// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// TOTP 凭据与恢复码(ADR 0027 第 8 节)。共享密钥只以 ADR 0026 的信封形式存放;恢复码只存加盐哈希。
// 存储层不做任何加解密或哈希:调用方传入已处理好的值。
import type { Connection } from './db.js';
import { newId } from './ids.js';

export interface TotpCredentialRecord {
    ownerId: string;
    /** ADR 0026 信封:主密钥加密的 Base32 共享密钥。 */
    secretEnc: string;
    enabled: boolean;
    lastUsedStep: number;
    createdAt: string;
    enabledAt: string | null;
}

export interface RecoveryCodeHash {
    salt: string;
    codeHash: string;
}

export interface RecoveryCodeRecord extends RecoveryCodeHash {
    id: string;
}

interface CredentialRow {
    ownerId: string;
    secretEnc: string;
    enabled: number;
    lastUsedStep: number;
    createdAt: string;
    enabledAt: string | null;
}

const CRED_COLUMNS = `owner_id AS "ownerId", secret_enc AS "secretEnc", enabled, last_used_step AS "lastUsedStep",
                      created_at AS "createdAt", enabled_at AS "enabledAt"`;

function toRecord(row: CredentialRow): TotpCredentialRecord {
    return { ...row, enabled: row.enabled === 1 };
}

export function createTotpRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const iso = () => now().toISOString();

    const q = {
        get: sqlite.prepare<[string], CredentialRow>(`SELECT ${CRED_COLUMNS} FROM totp_credentials WHERE owner_id = ?`),
        // 只覆盖尚未启用的旧密钥;已启用时不改任何东西(changes = 0)
        setup: sqlite.prepare(
            `INSERT INTO totp_credentials (owner_id, secret_enc, enabled, last_used_step, created_at)
             VALUES (@ownerId, @secretEnc, 0, 0, @at)
             ON CONFLICT(owner_id) DO UPDATE SET secret_enc = excluded.secret_enc, last_used_step = 0,
               created_at = excluded.created_at
             WHERE totp_credentials.enabled = 0`,
        ),
        enable: sqlite.prepare(
            `UPDATE totp_credentials SET enabled = 1, enabled_at = @at, last_used_step = @step
             WHERE owner_id = @ownerId AND enabled = 0 AND last_used_step < @step`,
        ),
        // 条件更新即重放保护:同一步长(或更早)的验证码只有一次能让 changes = 1
        consumeStep: sqlite.prepare(
            `UPDATE totp_credentials SET last_used_step = @step
             WHERE owner_id = @ownerId AND enabled = 1 AND last_used_step < @step`,
        ),
        deleteCredential: sqlite.prepare('DELETE FROM totp_credentials WHERE owner_id = ?'),
        setSecret: sqlite.prepare('UPDATE totp_credentials SET secret_enc = ? WHERE owner_id = ?'),
        insertCode: sqlite.prepare(
            `INSERT INTO totp_recovery_codes (id, owner_id, salt, code_hash, created_at)
             VALUES (@id, @ownerId, @salt, @codeHash, @at)`,
        ),
        deleteCodes: sqlite.prepare('DELETE FROM totp_recovery_codes WHERE owner_id = ?'),
        unusedCodes: sqlite.prepare<[string], RecoveryCodeRecord>(
            `SELECT id, salt, code_hash AS "codeHash" FROM totp_recovery_codes
             WHERE owner_id = ? AND used_at IS NULL ORDER BY created_at, id`,
        ),
        useCode: sqlite.prepare(
            'UPDATE totp_recovery_codes SET used_at = ? WHERE id = ? AND owner_id = ? AND used_at IS NULL',
        ),
        countCodes: sqlite.prepare<[string], { n: number }>(
            'SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE owner_id = ? AND used_at IS NULL',
        ),
        deleteOtherSessions: sqlite.prepare('DELETE FROM auth_sessions WHERE owner_id = ? AND id <> ?'),
        markSession: sqlite.prepare('UPDATE auth_sessions SET second_factor_at = ? WHERE id = ?'),
    };

    const replaceCodes = (ownerId: string, codes: readonly RecoveryCodeHash[]) => {
        const at = iso();
        q.deleteCodes.run(ownerId);
        for (const code of codes) q.insertCode.run({ id: newId(now()), ownerId, ...code, at });
    };

    return {
        get(ownerId: string): TotpCredentialRecord | null {
            const row = q.get.get(ownerId);
            return row ? toRecord(row) : null;
        },
        /** 保存待确认的共享密钥(覆盖未启用的旧密钥);已启用时返回 false 且不改动。 */
        saveSetup(ownerId: string, secretEnc: string): boolean {
            return q.setup.run({ ownerId, secretEnc, at: iso() }).changes > 0;
        },
        /**
         * 启用:一个事务内记下首次使用的时间步长、写入恢复码、撤销其他会话、把当前会话记为已通过第二因素。
         * 步长不大于已记录值或已经启用时返回 false(什么都不改)。
         */
        enable(input: {
            ownerId: string;
            step: number;
            codes: readonly RecoveryCodeHash[];
            keepSessionHash: string;
        }): boolean {
            return sqlite.transaction(() => {
                const at = iso();
                if (q.enable.run({ ownerId: input.ownerId, step: input.step, at }).changes === 0) return false;
                replaceCodes(input.ownerId, input.codes);
                q.deleteOtherSessions.run(input.ownerId, input.keepSessionHash);
                q.markSession.run(at, input.keepSessionHash);
                return true;
            })();
        },
        /** 记下验证码所在的时间步长;该步长已用过(或更早)返回 false。 */
        consumeStep(ownerId: string, step: number): boolean {
            return q.consumeStep.run({ ownerId, step }).changes > 0;
        },
        unusedRecoveryCodes(ownerId: string): RecoveryCodeRecord[] {
            return q.unusedCodes.all(ownerId);
        },
        /** 核销一个恢复码;已被使用返回 false。 */
        useRecoveryCode(ownerId: string, id: string): boolean {
            return q.useCode.run(iso(), id, ownerId).changes > 0;
        },
        recoveryCodesRemaining(ownerId: string): number {
            return q.countCodes.get(ownerId)?.n ?? 0;
        },
        /** 重新生成:旧码全部作废。 */
        replaceRecoveryCodes(ownerId: string, codes: readonly RecoveryCodeHash[]): void {
            sqlite.transaction(() => replaceCodes(ownerId, codes))();
        },
        /** 关闭:删除密钥与恢复码,撤销其他会话。 */
        disable(ownerId: string, keepSessionHash: string): void {
            sqlite.transaction(() => {
                q.deleteCodes.run(ownerId);
                q.deleteCredential.run(ownerId);
                q.deleteOtherSessions.run(ownerId, keepSessionHash);
            })();
        },
        /** 用某个会话(已通过第二因素的登录)标记 second_factor_at。 */
        markSecondFactor(sessionHash: string): void {
            q.markSession.run(iso(), sessionHash);
        },
    };
}

export type TotpRepository = ReturnType<typeof createTotpRepository>;

function hasTotpTables(conn: Connection): boolean {
    return (
        conn.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'totp_credentials'").get() !==
        undefined
    );
}

/**
 * 离线换主密钥(secrets rekey):在一个事务里把库内全部 TOTP 共享密钥换成新信封,然后执行 during()
 * (替换密钥文件等同步步骤)。during() 抛出时事务回滚,库里仍是旧信封。没有 TOTP 表时只执行 during()。
 * rewrap 对每个信封返回新信封(失败时抛出,同样回滚)。
 */
export function rekeyTotpSecrets<T>(
    conn: Connection,
    rewrap: (secretEnc: string) => string,
    during: () => T,
): { result: T; rewrapped: number } {
    if (!hasTotpTables(conn)) return { result: during(), rewrapped: 0 };
    return conn.sqlite.transaction(() => {
        const rows = conn.sqlite
            .prepare<[], { ownerId: string; secretEnc: string }>(
                'SELECT owner_id AS "ownerId", secret_enc AS "secretEnc" FROM totp_credentials',
            )
            .all();
        const update = conn.sqlite.prepare('UPDATE totp_credentials SET secret_enc = ? WHERE owner_id = ?');
        for (const row of rows) update.run(rewrap(row.secretEnc), row.ownerId);
        return { result: during(), rewrapped: rows.length };
    })();
}

/** 本机重置(auth reset-totp):删除凭据与恢复码、撤销全部会话、写一条审计。没有 TOTP 表或没有凭据时什么都不做。 */
export function resetTotpOffline(
    conn: Connection,
    now: () => Date = () => new Date(),
): { credentials: number; sessions: number } {
    if (!hasTotpTables(conn)) return { credentials: 0, sessions: 0 };
    return conn.sqlite.transaction(() => {
        const owners = conn.sqlite
            .prepare<[], { ownerId: string }>('SELECT owner_id AS "ownerId" FROM totp_credentials')
            .all();
        if (owners.length === 0) return { credentials: 0, sessions: 0 };
        const at = now().toISOString();
        let sessions = 0;
        for (const { ownerId } of owners) {
            conn.sqlite.prepare('DELETE FROM totp_recovery_codes WHERE owner_id = ?').run(ownerId);
            conn.sqlite.prepare('DELETE FROM totp_credentials WHERE owner_id = ?').run(ownerId);
            sessions += conn.sqlite.prepare('DELETE FROM auth_sessions WHERE owner_id = ?').run(ownerId).changes;
            // audit_log.action 有 CHECK 约束,新增动作需要重建表;迁移 0015 只新增,所以记为 tool-call + 固定名称
            conn.sqlite
                .prepare(
                    `INSERT INTO audit_log (id, owner_id, at, action, tool_name, risk, call_id, run_id, session_id,
                       decision, outcome, summary, input_digest, error)
                     VALUES (?, ?, ?, 'tool-call', 'auth.reset-totp', NULL, NULL, NULL, NULL, NULL, 'ok', ?, NULL, NULL)`,
                )
                .run(newId(now()), ownerId, at, 'TOTP 已本机重置');
        }
        return { credentials: owners.length, sessions };
    })();
}
