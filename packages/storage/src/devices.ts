// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设备配对与设备令牌(ADR 0045 第 1 节)。配对码与令牌只存 SHA-256,明文从不落库。
import type { Device, DeviceEvent, DeviceEventKind } from '@fatcat-ai/shared';
import type { Connection } from './db.js';
import { newId } from './ids.js';
import { selectList } from './schema.js';

/** 同一账户同时有效(未用、未过期)的配对码上限,防止被刷。 */
export const MAX_OPEN_PAIRING_CODES = 5;

export interface DeviceTokenHashes {
    accessHash: string;
    accessExpiresAt: Date;
    refreshHash: string;
    refreshExpiresAt: Date;
}

export type RotateResult =
    | { status: 'ok'; ownerId: string; device: Device }
    /** 已用过的 refresh 令牌被再次提交:设备已被吊销(检测被盗)。 */
    | { status: 'replay'; ownerId: string; deviceId: string }
    | { status: 'invalid' };

interface DeviceRow {
    id: string;
    ownerId: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    revokeReason: string | null;
}

interface TokenRow {
    tokenHash: string;
    deviceId: string;
    kind: 'access' | 'refresh';
    createdAt: string;
    expiresAt: string;
    usedAt: string | null;
}

const toDevice = (row: DeviceRow): Device => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
});

export function createDeviceRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const iso = () => now().toISOString();
    const deviceCols = selectList('devices');
    const tokenCols = selectList('device_tokens');

    const q = {
        insertCode: sqlite.prepare(
            `INSERT INTO pairing_codes (id, owner_id, code_hash, created_at, expires_at)
             VALUES (@id, @ownerId, @codeHash, @createdAt, @expiresAt)`,
        ),
        openCodes: sqlite.prepare<[string, string], { n: number }>(
            'SELECT count(*) AS n FROM pairing_codes WHERE owner_id = ? AND used_at IS NULL AND expires_at > ?',
        ),
        purgeCodes: sqlite.prepare('DELETE FROM pairing_codes WHERE expires_at <= ? OR used_at IS NOT NULL'),
        // 条件更新即「只能用一次」:并发的两次兑换只有一次 changes = 1
        consumeCode: sqlite.prepare<[string, string, string], { ownerId: string }>(
            `UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
             RETURNING owner_id AS "ownerId"`,
        ),
        insertDevice: sqlite.prepare(
            'INSERT INTO devices (id, owner_id, name, created_at) VALUES (@id, @ownerId, @name, @createdAt)',
        ),
        insertToken: sqlite.prepare(
            `INSERT INTO device_tokens (token_hash, device_id, kind, created_at, expires_at)
             VALUES (@tokenHash, @deviceId, @kind, @createdAt, @expiresAt)`,
        ),
        getDevice: sqlite.prepare<[string], DeviceRow>(`SELECT ${deviceCols} FROM devices WHERE id = ?`),
        listDevices: sqlite.prepare<[string], DeviceRow>(
            `SELECT ${deviceCols} FROM devices WHERE owner_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC`,
        ),
        tokenByHash: sqlite.prepare<[string], TokenRow>(`SELECT ${tokenCols} FROM device_tokens WHERE token_hash = ?`),
        markUsed: sqlite.prepare('UPDATE device_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'),
        deleteAccessOf: sqlite.prepare("DELETE FROM device_tokens WHERE device_id = ? AND kind = 'access'"),
        deleteTokensOf: sqlite.prepare('DELETE FROM device_tokens WHERE device_id = ?'),
        deleteExpiredTokens: sqlite.prepare('DELETE FROM device_tokens WHERE expires_at <= ?'),
        touchDevice: sqlite.prepare('UPDATE devices SET last_used_at = ? WHERE id = ?'),
        revoke: sqlite.prepare(
            'UPDATE devices SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL',
        ),
        rename: sqlite.prepare('UPDATE devices SET name = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL'),
        insertEvent: sqlite.prepare(
            `INSERT INTO device_events (id, owner_id, device_id, at, event, summary)
             VALUES (@id, @ownerId, @deviceId, @at, @event, @summary)`,
        ),
        events: sqlite.prepare<[string, number], DeviceEvent>(
            `SELECT id, at, event, device_id AS "deviceId", summary FROM device_events
             WHERE owner_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
        ),
    };

    function insertTokens(deviceId: string, tokens: DeviceTokenHashes): void {
        const createdAt = iso();
        q.insertToken.run({
            tokenHash: tokens.accessHash,
            deviceId,
            kind: 'access',
            createdAt,
            expiresAt: tokens.accessExpiresAt.toISOString(),
        });
        q.insertToken.run({
            tokenHash: tokens.refreshHash,
            deviceId,
            kind: 'refresh',
            createdAt,
            expiresAt: tokens.refreshExpiresAt.toISOString(),
        });
    }

    function revokeRow(ownerId: string, id: string, reason: 'owner' | 'replay' | 'self'): boolean {
        const changed = q.revoke.run(iso(), reason, id, ownerId).changes > 0;
        if (changed) q.deleteTokensOf.run(id);
        return changed;
    }

    const events = {
        append(ownerId: string, entry: { deviceId: string | null; event: DeviceEventKind; summary: string }): void {
            q.insertEvent.run({ id: newId(now()), ownerId, at: iso(), ...entry });
        },
        list(ownerId: string, limit = 100): DeviceEvent[] {
            return q.events.all(ownerId, limit);
        },
    };

    const devices = {
        /** 新建配对码;同时有效的码已达上限时返回 null。 */
        createPairingCode(ownerId: string, codeHash: string, expiresAt: Date): boolean {
            q.purgeCodes.run(iso());
            if ((q.openCodes.get(ownerId, iso())?.n ?? 0) >= MAX_OPEN_PAIRING_CODES) return false;
            q.insertCode.run({
                id: newId(now()),
                ownerId,
                codeHash,
                createdAt: iso(),
                expiresAt: expiresAt.toISOString(),
            });
            return true;
        },

        /** 配对码换设备:码必须存在、未用、未过期;成功时码立即作废。返回 null 表示码无效。 */
        pair(codeHash: string, name: string, tokens: DeviceTokenHashes): { ownerId: string; device: Device } | null {
            return sqlite.transaction(() => {
                const used = q.consumeCode.get(iso(), codeHash, iso());
                if (!used) return null;
                const row = { id: newId(now()), ownerId: used.ownerId, name, createdAt: iso() };
                q.insertDevice.run(row);
                insertTokens(row.id, tokens);
                return {
                    ownerId: used.ownerId,
                    device: { id: row.id, name, createdAt: row.createdAt, lastUsedAt: null },
                };
            })();
        },

        /**
         * 用 refresh 令牌换一组新令牌。refresh 令牌只能用一次:已用过的令牌再次出现说明有人拿到了旧令牌,
         * 整台设备立即吊销,不论是合法设备还是攻击者先用。
         */
        rotate(refreshHash: string, tokens: DeviceTokenHashes): RotateResult {
            return sqlite.transaction((): RotateResult => {
                const token = q.tokenByHash.get(refreshHash);
                if (token?.kind !== 'refresh') return { status: 'invalid' };
                const device = q.getDevice.get(token.deviceId);
                if (!device || device.revokedAt) return { status: 'invalid' };
                if (token.usedAt) {
                    revokeRow(device.ownerId, device.id, 'replay');
                    return { status: 'replay', ownerId: device.ownerId, deviceId: device.id };
                }
                if (token.expiresAt <= iso()) return { status: 'invalid' };
                q.markUsed.run(iso(), refreshHash);
                q.deleteAccessOf.run(device.id);
                insertTokens(device.id, tokens);
                q.touchDevice.run(iso(), device.id);
                return { status: 'ok', ownerId: device.ownerId, device: toDevice({ ...device, lastUsedAt: iso() }) };
            })();
        },

        /** 按 access 令牌哈希查设备(未过期、设备未吊销)。 */
        findByAccess(accessHash: string): { deviceId: string; ownerId: string; lastUsedAt: string | null } | null {
            const token = q.tokenByHash.get(accessHash);
            if (token?.kind !== 'access' || token.expiresAt <= iso()) return null;
            const device = q.getDevice.get(token.deviceId);
            if (!device || device.revokedAt) return null;
            return { deviceId: device.id, ownerId: device.ownerId, lastUsedAt: device.lastUsedAt };
        },

        touch(deviceId: string): void {
            q.touchDevice.run(iso(), deviceId);
        },

        list(ownerId: string): Device[] {
            return q.listDevices.all(ownerId).map(toDevice);
        },

        rename(ownerId: string, id: string, name: string): boolean {
            return q.rename.run(name, id, ownerId).changes > 0;
        },

        revoke(ownerId: string, id: string, reason: 'owner' | 'self'): boolean {
            return sqlite.transaction(() => revokeRow(ownerId, id, reason))();
        },

        /** 清掉过期的令牌与配对码。 */
        purgeExpired(): void {
            q.deleteExpiredTokens.run(iso());
            q.purgeCodes.run(iso());
        },

        events,
    };
    return devices;
}

export type DeviceRepository = ReturnType<typeof createDeviceRepository>;
