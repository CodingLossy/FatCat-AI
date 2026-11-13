// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 登录会话与个人访问令牌。表中只存令牌的哈希,明文从不落库(ADR 0004 第 2 节)。
import type { AccessToken } from '@fatcat-ai/shared';
import type { Connection } from './db.js';
import { newId } from './ids.js';
import { selectList, type AccessTokenRow, type AuthSessionRow } from './schema.js';

export type AuthSessionRecord = AuthSessionRow;
export type AccessTokenRecord = Omit<AccessTokenRow, 'tokenHash'>;

function toAccessToken(row: AccessTokenRecord): AccessToken {
    return {
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        expiresAt: row.expiresAt,
    };
}

export function createAuthRepositories(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const iso = () => now().toISOString();

    const sessionQ = {
        insert: sqlite.prepare(
            `INSERT INTO auth_sessions (id, owner_id, csrf_hash, created_at, expires_at, last_seen_at, second_factor_at)
             VALUES (@id, @ownerId, @csrfHash, @createdAt, @expiresAt, @lastSeenAt, @secondFactorAt)`,
        ),
        valid: sqlite.prepare<[string, string], AuthSessionRow>(
            `SELECT ${selectList('auth_sessions')} FROM auth_sessions WHERE id = ? AND expires_at > ?`,
        ),
        touch: sqlite.prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?'),
        delete: sqlite.prepare('DELETE FROM auth_sessions WHERE id = ?'),
        deleteOthers: sqlite.prepare('DELETE FROM auth_sessions WHERE owner_id = ? AND id <> ?'),
        deleteAll: sqlite.prepare('DELETE FROM auth_sessions WHERE owner_id = ?'),
        deleteExpired: sqlite.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?'),
    };

    const authSessions = {
        /** idHash 为会话令牌的 SHA-256。 */
        create(input: {
            idHash: string;
            ownerId: string;
            csrfHash: string;
            expiresAt: Date;
            /** 已通过第二因素(TOTP 登录成功)的会话。 */
            secondFactor?: boolean;
        }): AuthSessionRecord {
            const at = iso();
            const row = {
                id: input.idHash,
                ownerId: input.ownerId,
                csrfHash: input.csrfHash,
                createdAt: at,
                expiresAt: input.expiresAt.toISOString(),
                lastSeenAt: at,
                secondFactorAt: input.secondFactor ? at : null,
            };
            sessionQ.insert.run(row);
            return row;
        },
        /** 只返回未过期的会话。 */
        getValid(idHash: string): AuthSessionRecord | null {
            return sessionQ.valid.get(idHash, iso()) ?? null;
        },
        touch(idHash: string, expiresAt: Date): void {
            sessionQ.touch.run(iso(), expiresAt.toISOString(), idHash);
        },
        delete(idHash: string): void {
            sessionQ.delete.run(idHash);
        },
        deleteExpired(): number {
            return sessionQ.deleteExpired.run(iso()).changes;
        },
        /** 撤销除 keepIdHash 之外的该用户全部会话(启用或关闭 TOTP 时)。 */
        deleteOthers(ownerId: string, keepIdHash: string): number {
            return sessionQ.deleteOthers.run(ownerId, keepIdHash).changes;
        },
        deleteAll(ownerId: string): number {
            return sessionQ.deleteAll.run(ownerId).changes;
        },
    };

    const tokenColumns = `id, owner_id AS "ownerId", name, created_at AS "createdAt", last_used_at AS "lastUsedAt",
                          expires_at AS "expiresAt", revoked_at AS "revokedAt"`;
    const tokenQ = {
        insert: sqlite.prepare(
            `INSERT INTO access_tokens (id, owner_id, name, token_hash, created_at, expires_at)
             VALUES (@id, @ownerId, @name, @tokenHash, @createdAt, @expiresAt)`,
        ),
        list: sqlite.prepare<[string], AccessTokenRecord>(
            `SELECT ${tokenColumns} FROM access_tokens WHERE owner_id = ? AND revoked_at IS NULL
             ORDER BY created_at DESC, id DESC`,
        ),
        usable: sqlite.prepare<[string, string], AccessTokenRecord>(
            `SELECT ${tokenColumns} FROM access_tokens
             WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
        ),
        touch: sqlite.prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?'),
        revoke: sqlite.prepare(
            'UPDATE access_tokens SET revoked_at = ? WHERE owner_id = ? AND id = ? AND revoked_at IS NULL',
        ),
    };

    const accessTokens = {
        create(input: { ownerId: string; name: string; tokenHash: string; expiresAt: Date | null }): AccessToken {
            const row = {
                id: newId(now()),
                ownerId: input.ownerId,
                name: input.name,
                tokenHash: input.tokenHash,
                createdAt: iso(),
                expiresAt: input.expiresAt?.toISOString() ?? null,
            };
            tokenQ.insert.run(row);
            return toAccessToken({ ...row, lastUsedAt: null, revokedAt: null });
        },
        /** 未吊销的令牌,按创建时间倒序。 */
        list(ownerId: string): AccessToken[] {
            return tokenQ.list.all(ownerId).map(toAccessToken);
        },
        /** 按哈希查找可用令牌(未吊销、未过期)。 */
        findUsable(tokenHash: string): AccessTokenRecord | null {
            return tokenQ.usable.get(tokenHash, iso()) ?? null;
        },
        touch(id: string): void {
            tokenQ.touch.run(iso(), id);
        },
        revoke(ownerId: string, id: string): boolean {
            return tokenQ.revoke.run(iso(), ownerId, id).changes > 0;
        },
    };

    return { authSessions, accessTokens };
}
