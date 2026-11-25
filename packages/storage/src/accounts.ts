// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 账户管理(ADR 0053 第 2 节):邀请码、重置码、改角色、停用、删除。只给管理员路由用(requireAdmin),
// 所以这里的方法不带 ownerId,在 scripts/owner-scope.json 里登记为 system。码只存 SHA-256,明文从不落库。
import type { Connection } from './db.js';
import { newId } from './ids.js';
import type { OwnerRole } from './schema.js';

/** 同一个管理员同时有效(未用、未过期)的邀请码与重置码上限。 */
export const MAX_OPEN_ACCOUNT_CODES = 10;

export interface AccountRecord {
    id: string;
    username: string;
    displayName: string | null;
    role: OwnerRole;
    disabledAt: string | null;
    createdAt: string;
    totpEnabled: boolean;
}

export type AcceptInviteResult =
    | { status: 'ok'; owner: { id: string; username: string; role: OwnerRole; createdAt: string } }
    | { status: 'invalid' }
    | { status: 'username_taken' };

/** 改角色、停用、删除的结果;`last_admin` 是触发器拒绝了(最后一个未停用的管理员)。 */
export type AccountChange = 'ok' | 'not_found' | 'last_admin';

const isLastAdmin = (error: unknown) => error instanceof Error && /at least one active admin/.test(error.message);

export function createAccountRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const iso = () => now().toISOString();
    const accountCols = `o.id AS "id", o.username AS "username", o.display_name AS "displayName", o.role AS "role",
        o.disabled_at AS "disabledAt", o.created_at AS "createdAt",
        COALESCE((SELECT t.enabled FROM totp_credentials t WHERE t.owner_id = o.id), 0) AS "totpEnabled"`;
    // 码只在生成它的管理员仍是未停用的管理员时有效
    const issuerActive = `owner_id IN (SELECT id FROM owners WHERE role = 'admin' AND disabled_at IS NULL)`;

    let statements: ReturnType<typeof prepare> | null = null;
    const prepare = () => ({
        list: sqlite.prepare<[], AccountRecord & { totpEnabled: number }>(
            `SELECT ${accountCols} FROM owners o ORDER BY o.created_at, o.id`,
        ),
        get: sqlite.prepare<[string], AccountRecord & { totpEnabled: number }>(
            `SELECT ${accountCols} FROM owners o WHERE o.id = ?`,
        ),
        openCodes: sqlite.prepare<[string, string], { n: number }>(
            'SELECT count(*) AS n FROM account_codes WHERE owner_id = ? AND used_at IS NULL AND expires_at > ?',
        ),
        insertCode: sqlite.prepare(
            `INSERT INTO account_codes (id, owner_id, kind, target_owner_id, code_hash, created_at, expires_at)
             VALUES (@id, @ownerId, @kind, @targetOwnerId, @codeHash, @createdAt, @expiresAt)`,
        ),
        // 条件更新即「只能用一次」:并发的两次兑换只有一次拿到行
        consume: sqlite.prepare<[string, string, string, string], { targetOwnerId: string | null }>(
            `UPDATE account_codes SET used_at = ?
             WHERE code_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ? AND ${issuerActive}
             RETURNING target_owner_id AS "targetOwnerId"`,
        ),
        usernameTaken: sqlite.prepare<[string], { id: string }>('SELECT id FROM owners WHERE username = ?'),
        insertOwner: sqlite.prepare(
            `INSERT INTO owners (id, username, password_hash, created_at, updated_at, role, display_name)
             VALUES (@id, @username, @passwordHash, @createdAt, @createdAt, 'member', @displayName)`,
        ),
        setPassword: sqlite.prepare('UPDATE owners SET password_hash = ?, updated_at = ? WHERE id = ?'),
        setRole: sqlite.prepare('UPDATE owners SET role = ?, updated_at = ? WHERE id = ?'),
        setDisabled: sqlite.prepare('UPDATE owners SET disabled_at = ?, updated_at = ? WHERE id = ?'),
        setDisplayName: sqlite.prepare('UPDATE owners SET display_name = ?, updated_at = ? WHERE id = ?'),
        remove: sqlite.prepare('DELETE FROM owners WHERE id = ?'),
        deleteSessions: sqlite.prepare('DELETE FROM auth_sessions WHERE owner_id = ?'),
        revokeTokens: sqlite.prepare(
            'UPDATE access_tokens SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL',
        ),
        deleteDeviceTokens: sqlite.prepare(
            'DELETE FROM device_tokens WHERE device_id IN (SELECT id FROM devices WHERE owner_id = ?)',
        ),
        revokeDevices: sqlite.prepare(
            "UPDATE devices SET revoked_at = ?, revoke_reason = 'owner' WHERE owner_id = ? AND revoked_at IS NULL",
        ),
        deletePairingCodes: sqlite.prepare('DELETE FROM pairing_codes WHERE owner_id = ? AND used_at IS NULL'),
        deleteResetCodes: sqlite.prepare(
            "DELETE FROM account_codes WHERE target_owner_id = ? AND kind = 'reset' AND used_at IS NULL",
        ),
        deleteIssuedCodes: sqlite.prepare('DELETE FROM account_codes WHERE owner_id = ? AND used_at IS NULL'),
        usable: sqlite.prepare<[string, string, string], { n: number }>(
            `SELECT 1 AS n FROM account_codes
             WHERE code_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ? AND ${issuerActive}`,
        ),
    });
    const q = () => (statements ??= prepare());
    const toAccount = (row: AccountRecord & { totpEnabled: number | boolean }): AccountRecord => ({
        ...row,
        totpEnabled: Boolean(row.totpEnabled),
    });

    /** 登录会话、个人访问令牌、设备(连同设备令牌)、未用的配对码和重置码全部作废。 */
    function revokeCredentials(ownerId: string): void {
        const at = iso();
        q().deleteSessions.run(ownerId);
        q().revokeTokens.run(at, ownerId);
        q().deleteDeviceTokens.run(ownerId);
        q().revokeDevices.run(at, ownerId);
        q().deletePairingCodes.run(ownerId);
        q().deleteResetCodes.run(ownerId);
    }

    function guarded(fn: () => number): AccountChange {
        try {
            return fn() > 0 ? 'ok' : 'not_found';
        } catch (error) {
            if (isLastAdmin(error)) return 'last_admin';
            throw error;
        }
    }

    return {
        list(): AccountRecord[] {
            return q().list.all().map(toAccount);
        },

        get(id: string): AccountRecord | null {
            const row = q().get.get(id);
            return row ? toAccount(row) : null;
        },

        /** 生成邀请码(target 为 null)或某个账户的重置码;未用的码超过上限时返回 false。 */
        createCode(input: {
            adminId: string;
            kind: 'invite' | 'reset';
            targetOwnerId: string | null;
            codeHash: string;
            expiresAt: Date;
        }): boolean {
            return sqlite.transaction(() => {
                const at = iso();
                if ((q().openCodes.get(input.adminId, at)?.n ?? 0) >= MAX_OPEN_ACCOUNT_CODES) return false;
                q().insertCode.run({
                    id: newId(now()),
                    ownerId: input.adminId,
                    kind: input.kind,
                    targetOwnerId: input.targetOwnerId,
                    codeHash: input.codeHash,
                    createdAt: at,
                    expiresAt: input.expiresAt.toISOString(),
                });
                return true;
            })();
        },

        /** 只读预检:这个码现在能不能用(调用方据此决定要不要做昂贵的密码哈希)。不消耗码。 */
        isCodeUsable(codeHash: string, kind: 'invite' | 'reset'): boolean {
            return q().usable.get(codeHash, kind, iso()) !== undefined;
        },

        /**
         * 用邀请码建成员账户。先核对邀请码:码无效时只回答 `invalid`,不透露用户名是否存在;
         * 码有效但用户名已被占用时回滚(码不被消耗),回答 `username_taken`。
         */
        acceptInvite(
            codeHash: string,
            input: { username: string; passwordHash: string; displayName: string | null },
        ): AcceptInviteResult {
            const taken = new Error('username taken');
            try {
                return sqlite.transaction((): AcceptInviteResult => {
                    const at = iso();
                    if (!q().consume.get(at, codeHash, 'invite', at)) return { status: 'invalid' };
                    if (q().usernameTaken.get(input.username)) throw taken; // 回滚,码不被消耗
                    const id = newId(now());
                    q().insertOwner.run({ id, ...input, createdAt: at });
                    return { status: 'ok', owner: { id, username: input.username, role: 'member', createdAt: at } };
                })();
            } catch (error) {
                if (error === taken) return { status: 'username_taken' };
                throw error;
            }
        },

        /** 用重置码设新密码;成功后这个账户的会话、令牌和设备全部作废(TOTP 保留)。 */
        resetPassword(codeHash: string, passwordHash: string): { ownerId: string } | null {
            return sqlite.transaction(() => {
                const at = iso();
                const row = q().consume.get(at, codeHash, 'reset', at);
                if (!row?.targetOwnerId) return null;
                q().setPassword.run(passwordHash, at, row.targetOwnerId);
                revokeCredentials(row.targetOwnerId);
                return { ownerId: row.targetOwnerId };
            })();
        },

        /** 降为成员时,这个账户以管理员身份发出的未用的码一并作废(以后再升回管理员也不恢复)。 */
        setRole(id: string, role: OwnerRole): AccountChange {
            return sqlite.transaction(() => {
                const result = guarded(() => q().setRole.run(role, iso(), id).changes);
                if (result === 'ok' && role === 'member') q().deleteIssuedCodes.run(id);
                return result;
            })();
        },

        /** 停用时立即作废这个账户的全部凭据和它发出的码;启用不会恢复它们,要重新登录。 */
        setDisabled(id: string, disabled: boolean): AccountChange {
            return sqlite.transaction(() => {
                const result = guarded(() => q().setDisabled.run(disabled ? iso() : null, iso(), id).changes);
                if (result === 'ok' && disabled) {
                    revokeCredentials(id);
                    q().deleteIssuedCodes.run(id); // 它发出的码也作废,启用后不恢复
                }
                return result;
            })();
        },

        setDisplayName(id: string, displayName: string | null): boolean {
            return q().setDisplayName.run(displayName, iso(), id).changes > 0;
        },

        /** 删除账户:靠 ON DELETE CASCADE 删掉它的全部行(调用方先备份数据库)。 */
        remove(id: string): AccountChange {
            return guarded(() => q().remove.run(id).changes);
        },

        revokeCredentials,
    };
}

export type AccountRepository = ReturnType<typeof createAccountRepository>;
