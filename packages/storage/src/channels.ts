// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ChannelKind } from '@fatcat-ai/shared';
import type { Connection } from './db.js';
import { newId } from './ids.js';

/** 渠道配置(ADR 0022 第 10 节);config 只含 env: / file: 引用,API 响应里不返回。 */
export interface ChannelRecord {
    id: string;
    ownerId: string;
    kind: ChannelKind;
    label: string;
    enabled: boolean;
    sessionId: string | null;
    notifyDegraded: boolean;
    config: Record<string, string>;
    createdAt: string;
    updatedAt: string;
    binding: { externalUserId: string; boundAt: string } | null;
}

export interface ChannelPairingRecord {
    codeHash: string;
    expiresAt: string;
    failedAttempts: number;
}

interface Row {
    id: string;
    ownerId: string;
    kind: string;
    label: string;
    enabled: number;
    sessionId: string | null;
    notifyDegraded: number;
    configJson: string;
    createdAt: string;
    updatedAt: string;
    externalUserId: string | null;
    boundAt: string | null;
}

const SELECT = `SELECT c.id, c.owner_id AS ownerId, c.kind, c.label, c.enabled, c.session_id AS sessionId,
    c.notify_degraded AS notifyDegraded, c.config_json AS configJson, c.created_at AS createdAt,
    c.updated_at AS updatedAt, b.external_user_id AS externalUserId, b.bound_at AS boundAt
  FROM channels c LEFT JOIN channel_bindings b ON b.channel_id = c.id`;

function toRecord(row: Row): ChannelRecord {
    return {
        id: row.id,
        ownerId: row.ownerId,
        kind: row.kind as ChannelKind,
        label: row.label,
        enabled: row.enabled === 1,
        sessionId: row.sessionId,
        notifyDegraded: row.notifyDegraded === 1,
        config: JSON.parse(row.configJson) as Record<string, string>,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        binding:
            row.externalUserId !== null && row.boundAt !== null
                ? { externalUserId: row.externalUserId, boundAt: row.boundAt }
                : null,
    };
}

/** IM 渠道、主人绑定、配对码与入站去重(ADR 0022 第 3、8、10 节)。 */
export function createChannelRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const q = {
        list: sqlite.prepare<[string], Row>(`${SELECT} WHERE c.owner_id = ? ORDER BY c.created_at, c.id`),
        enabled: sqlite.prepare<[], Row>(`${SELECT} WHERE c.enabled = 1 ORDER BY c.created_at, c.id`),
        get: sqlite.prepare<[string, string], Row>(`${SELECT} WHERE c.owner_id = ? AND c.id = ?`),
        insert: sqlite.prepare(
            `INSERT INTO channels (id, owner_id, kind, label, enabled, notify_degraded, config_json, created_at,
               updated_at)
             VALUES (@id, @ownerId, @kind, @label, 0, 0, @config, @at, @at)`,
        ),
        update: sqlite.prepare(
            `UPDATE channels SET label = @label, enabled = @enabled, notify_degraded = @notifyDegraded,
               updated_at = @at WHERE id = @id`,
        ),
        setConfig: sqlite.prepare<[string, string, string]>(
            'UPDATE channels SET config_json = ?, updated_at = ? WHERE id = ?',
        ),
        setSession: sqlite.prepare<[string | null, string, string]>(
            'UPDATE channels SET session_id = ?, updated_at = ? WHERE id = ?',
        ),
        delete: sqlite.prepare<[string, string]>('DELETE FROM channels WHERE owner_id = ? AND id = ?'),
        bind: sqlite.prepare<[string, string, string]>(
            `INSERT INTO channel_bindings (channel_id, external_user_id, bound_at) VALUES (?, ?, ?)
             ON CONFLICT (channel_id) DO NOTHING`,
        ),
        unbind: sqlite.prepare<[string]>('DELETE FROM channel_bindings WHERE channel_id = ?'),
        setPairing: sqlite.prepare<[string, string, string]>(
            `INSERT INTO channel_pairings (channel_id, code_hash, expires_at, failed_attempts) VALUES (?, ?, ?, 0)
             ON CONFLICT (channel_id) DO UPDATE SET code_hash = excluded.code_hash,
               expires_at = excluded.expires_at, failed_attempts = 0`,
        ),
        getPairing: sqlite.prepare<[string], ChannelPairingRecord>(
            `SELECT code_hash AS codeHash, expires_at AS expiresAt, failed_attempts AS failedAttempts
             FROM channel_pairings WHERE channel_id = ?`,
        ),
        failPairing: sqlite.prepare<[string]>(
            'UPDATE channel_pairings SET failed_attempts = failed_attempts + 1 WHERE channel_id = ?',
        ),
        deletePairing: sqlite.prepare<[string]>('DELETE FROM channel_pairings WHERE channel_id = ?'),
        inbox: sqlite.prepare<[string, string, string]>(
            `INSERT INTO channel_inbox (channel_id, external_message_id, received_at) VALUES (?, ?, ?)
             ON CONFLICT DO NOTHING`,
        ),
        pruneInbox: sqlite.prepare<[string]>('DELETE FROM channel_inbox WHERE received_at < ?'),
    };
    const iso = () => now().toISOString();
    const byId = sqlite.prepare<[string], Row>(`${SELECT} WHERE c.id = ?`);

    return {
        list(ownerId: string): ChannelRecord[] {
            return q.list.all(ownerId).map(toRecord);
        },
        /** 启动时:所有 owner 的已启用渠道。 */
        allEnabled(): ChannelRecord[] {
            return q.enabled.all().map(toRecord);
        },
        get(ownerId: string, id: string): ChannelRecord | null {
            const row = q.get.get(ownerId, id);
            return row ? toRecord(row) : null;
        },
        /** 运行器内部用(已知渠道属于哪个 owner 时)。 */
        byId(id: string): ChannelRecord | null {
            const row = byId.get(id);
            return row ? toRecord(row) : null;
        },
        create(ownerId: string, input: { kind: ChannelKind; label: string; config?: Record<string, string> }) {
            const id = newId(now());
            q.insert.run({
                id,
                ownerId,
                kind: input.kind,
                label: input.label,
                config: JSON.stringify(input.config ?? {}),
                at: iso(),
            });
            return this.get(ownerId, id)!;
        },
        update(
            ownerId: string,
            id: string,
            patch: { label?: string | undefined; enabled?: boolean | undefined; notifyDegraded?: boolean | undefined },
        ): ChannelRecord | null {
            const current = this.get(ownerId, id);
            if (!current) return null;
            q.update.run({
                id,
                label: patch.label ?? current.label,
                enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
                notifyDegraded: (patch.notifyDegraded ?? current.notifyDegraded) ? 1 : 0,
                at: iso(),
            });
            return this.get(ownerId, id);
        },
        /** 渠道配置只含密钥引用与非机密设置(ADR 0022 第 9 节);整份替换。 */
        setConfig(id: string, config: Record<string, string>): void {
            q.setConfig.run(JSON.stringify(config), iso(), id);
        },
        setSession(id: string, sessionId: string | null): void {
            q.setSession.run(sessionId, iso(), id);
        },
        delete(ownerId: string, id: string): boolean {
            return q.delete.run(ownerId, id).changes > 0;
        },
        /** 绑定主人;已有主人时不改变,返回 false。 */
        bind(id: string, externalUserId: string): boolean {
            return q.bind.run(id, externalUserId, iso()).changes > 0;
        },
        unbind(id: string): boolean {
            return q.unbind.run(id).changes > 0;
        },
        /** 新的配对码(作废上一个,失败次数清零)。 */
        setPairing(id: string, codeHash: string, expiresAt: Date): void {
            q.setPairing.run(id, codeHash, expiresAt.toISOString());
        },
        getPairing(id: string): ChannelPairingRecord | null {
            return q.getPairing.get(id) ?? null;
        },
        failPairing(id: string): void {
            q.failPairing.run(id);
        },
        deletePairing(id: string): void {
            q.deletePairing.run(id);
        },
        /** 记录一条入站消息;已经见过时返回 false(去重,ADR 0022 第 8 节)。 */
        recordInbound(id: string, externalMessageId: string): boolean {
            return q.inbox.run(id, externalMessageId, iso()).changes > 0;
        },
        /** 删除早于 before 的去重记录,返回删除的条数。 */
        pruneInbox(before: Date): number {
            return q.pruneInbox.run(before.toISOString()).changes;
        },
    };
}

export type ChannelRepository = ReturnType<typeof createChannelRepository>;
