// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';
import { decodeCursor, encodeCursor, type Page } from './cursor.js';
import type { Connection } from './db.js';
import { newId } from './ids.js';

export const PLUGIN_STATES = [
    'enabled',
    'disabled',
    'error',
    'incompatible',
    'upgrade-pending',
    'uninstalling',
    'uninstalled',
] as const;
export type PluginState = (typeof PLUGIN_STATES)[number];

export const PLUGIN_EVENT_KINDS = [
    'installed',
    'upgraded',
    'upgrade-failed',
    'uninstalled',
    'enabled',
    'disabled',
    'stopped',
    'denied',
    'checksum-mismatch',
    'market-rejected',
    'crashed',
    'memory-threshold',
] as const;
export type PluginEventKind = (typeof PLUGIN_EVENT_KINDS)[number];

export interface PluginRecord {
    id: string;
    ownerId: string;
    /** 清单里的 id。 */
    pluginId: string;
    version: string;
    previousVersion: string | null;
    sourceKind: 'local' | 'market';
    sourceRef: string;
    signedKeyId: string | null;
    contentSha256: string;
    manifest: unknown;
    granted: unknown;
    /** 名字 -> 'env:变量名';只存引用,不存值。 */
    secretRefs: Record<string, string>;
    settings: Record<string, unknown>;
    state: PluginState;
    error: string | null;
    /** 管理员把插件开放给成员(ADR 0053 第 4.2 节)。 */
    sharedWithMembers: boolean;
    installedAt: string;
    updatedAt: string;
}

export interface NewPlugin {
    pluginId: string;
    version: string;
    sourceKind: 'local' | 'market';
    sourceRef: string;
    signedKeyId?: string | null | undefined;
    contentSha256: string;
    manifest: unknown;
    granted: unknown;
    secretRefs?: Record<string, string> | undefined;
    settings?: Record<string, unknown> | undefined;
    state?: PluginState | undefined;
}

export interface PluginPatch {
    version?: string | undefined;
    previousVersion?: string | null | undefined;
    sourceKind?: 'local' | 'market' | undefined;
    sourceRef?: string | undefined;
    signedKeyId?: string | null | undefined;
    contentSha256?: string | undefined;
    manifest?: unknown;
    granted?: unknown;
    secretRefs?: Record<string, string> | undefined;
    settings?: Record<string, unknown> | undefined;
    state?: PluginState | undefined;
    error?: string | null | undefined;
    sharedWithMembers?: boolean | undefined;
}

export interface PluginEventRecord {
    id: string;
    ownerId: string;
    at: string;
    pluginId: string;
    version: string | null;
    kind: PluginEventKind;
    detail: string | null;
}

interface PluginRow {
    id: string;
    ownerId: string;
    pluginId: string;
    version: string;
    previousVersion: string | null;
    sourceKind: 'local' | 'market';
    sourceRef: string;
    signedKeyId: string | null;
    contentSha256: string;
    manifestJson: string;
    grantedJson: string;
    secretRefsJson: string;
    settingsJson: string;
    state: PluginState;
    error: string | null;
    sharedWithMembers: number;
    installedAt: string;
    updatedAt: string;
}

const PLUGIN_SELECT = `SELECT id, owner_id AS ownerId, plugin_id AS pluginId, version, previous_version AS previousVersion,
    source_kind AS sourceKind, source_ref AS sourceRef, signed_key_id AS signedKeyId, content_sha256 AS contentSha256,
    manifest_json AS manifestJson, granted_json AS grantedJson, secret_refs_json AS secretRefsJson,
    settings_json AS settingsJson, state, error, shared_with_members AS sharedWithMembers, installed_at AS installedAt, updated_at AS updatedAt FROM plugins`;
const EVENT_SELECT = `SELECT id, owner_id AS ownerId, at, plugin_id AS pluginId, version, kind, detail FROM plugin_events`;

const EventCursor = z.object({ at: z.string(), id: z.string() });

function toPlugin(row: PluginRow): PluginRecord {
    const { manifestJson, grantedJson, secretRefsJson, settingsJson, sharedWithMembers, ...rest } = row;
    return {
        ...rest,
        sharedWithMembers: sharedWithMembers === 1,
        manifest: JSON.parse(manifestJson) as unknown,
        granted: JSON.parse(grantedJson) as unknown,
        secretRefs: JSON.parse(secretRefsJson) as Record<string, string>,
        settings: JSON.parse(settingsJson) as Record<string, unknown>,
    };
}

/** 已安装插件与插件事件(ADR 0040 第 7 节)。事件只存短文本,不存参数与正文;卸载后保留。 */
export function createPluginRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const q = {
        list: sqlite.prepare<[string], PluginRow>(`${PLUGIN_SELECT} WHERE owner_id = ? ORDER BY plugin_id`),
        listAll: sqlite.prepare<[], PluginRow>(`${PLUGIN_SELECT} ORDER BY owner_id, plugin_id`),
        get: sqlite.prepare<[string, string], PluginRow>(`${PLUGIN_SELECT} WHERE owner_id = ? AND plugin_id = ?`),
        sharedFrom: sqlite.prepare<[string], PluginRow>(
            `${PLUGIN_SELECT} WHERE shared_with_members = 1 AND owner_id <> ? AND state <> 'uninstalled'
                AND owner_id IN (SELECT id FROM owners WHERE role = 'admin' AND disabled_at IS NULL)
             ORDER BY plugin_id`,
        ),
        insert: sqlite.prepare(
            `INSERT INTO plugins (id, owner_id, plugin_id, version, source_kind, source_ref, signed_key_id,
               content_sha256, manifest_json, granted_json, secret_refs_json, settings_json, state, installed_at, updated_at)
             VALUES (@id, @ownerId, @pluginId, @version, @sourceKind, @sourceRef, @signedKeyId, @sha, @manifest,
               @granted, @secretRefs, @settings, @state, @at, @at)`,
        ),
        update: sqlite.prepare(
            `UPDATE plugins SET version = @version, previous_version = @previousVersion, source_kind = @sourceKind, source_ref = @sourceRef,
               signed_key_id = @signedKeyId, content_sha256 = @sha, manifest_json = @manifest, granted_json = @granted,
               secret_refs_json = @secretRefs, settings_json = @settings, state = @state, error = @error,
               shared_with_members = @shared, updated_at = @at
             WHERE owner_id = @ownerId AND plugin_id = @pluginId`,
        ),
        delete: sqlite.prepare<[string, string]>('DELETE FROM plugins WHERE owner_id = ? AND plugin_id = ?'),
        eventInsert: sqlite.prepare(
            `INSERT INTO plugin_events (id, owner_id, at, plugin_id, version, kind, detail)
             VALUES (@id, @ownerId, @at, @pluginId, @version, @kind, @detail)`,
        ),
        eventsFirst: sqlite.prepare<[string, string | null, string | null, number], PluginEventRow>(
            `${EVENT_SELECT} WHERE owner_id = ? AND (? IS NULL OR plugin_id = ?) ORDER BY at DESC, id DESC LIMIT ?`,
        ),
        eventsAfter: sqlite.prepare<
            [string, string | null, string | null, string, string, string, number],
            PluginEventRow
        >(
            `${EVENT_SELECT} WHERE owner_id = ? AND (? IS NULL OR plugin_id = ?)
               AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?`,
        ),
        eventsPurge: sqlite.prepare<[string]>('DELETE FROM plugin_events WHERE at < ?'),
    };
    type PluginEventRow = PluginEventRecord;

    return {
        list(ownerId: string): PluginRecord[] {
            return q.list.all(ownerId).map(toPlugin);
        },
        /**
         * 未停用的管理员开放给成员、这个账户自己没装的插件(ADR 0053 第 4.2 节);管理员降级或停用后立即不再出现。
         * 不含已卸载的。
         */
        listSharedWith(ownerId: string): PluginRecord[] {
            return q.sharedFrom.all(ownerId).map(toPlugin);
        },
        /** 全部 owner 的插件(服务启动时拉起已启用的插件用)。 */
        listAll(): PluginRecord[] {
            return q.listAll.all().map(toPlugin);
        },
        get(ownerId: string, pluginId: string): PluginRecord | null {
            const row = q.get.get(ownerId, pluginId);
            return row ? toPlugin(row) : null;
        },
        /** 同一 owner 下 pluginId 唯一;重复安装抛出 UNIQUE 错误,由调用方改走升级。 */
        create(ownerId: string, input: NewPlugin): PluginRecord {
            q.insert.run({
                id: newId(now()),
                ownerId,
                pluginId: input.pluginId,
                version: input.version,
                sourceKind: input.sourceKind,
                sourceRef: input.sourceRef,
                signedKeyId: input.signedKeyId ?? null,
                sha: input.contentSha256,
                manifest: JSON.stringify(input.manifest),
                granted: JSON.stringify(input.granted),
                secretRefs: JSON.stringify(input.secretRefs ?? {}),
                settings: JSON.stringify(input.settings ?? {}),
                state: input.state ?? 'disabled',
                at: now().toISOString(),
            });
            return toPlugin(q.get.get(ownerId, input.pluginId)!);
        },
        update(ownerId: string, pluginId: string, patch: PluginPatch): PluginRecord | null {
            const current = q.get.get(ownerId, pluginId);
            if (!current) return null;
            q.update.run({
                ownerId,
                pluginId,
                version: patch.version ?? current.version,
                previousVersion: patch.previousVersion !== undefined ? patch.previousVersion : current.previousVersion,
                sourceKind: patch.sourceKind ?? current.sourceKind,
                sourceRef: patch.sourceRef ?? current.sourceRef,
                signedKeyId: patch.signedKeyId !== undefined ? patch.signedKeyId : current.signedKeyId,
                sha: patch.contentSha256 ?? current.contentSha256,
                manifest: patch.manifest !== undefined ? JSON.stringify(patch.manifest) : current.manifestJson,
                granted: patch.granted !== undefined ? JSON.stringify(patch.granted) : current.grantedJson,
                secretRefs: patch.secretRefs ? JSON.stringify(patch.secretRefs) : current.secretRefsJson,
                settings: patch.settings ? JSON.stringify(patch.settings) : current.settingsJson,
                state: patch.state ?? current.state,
                error: patch.error !== undefined ? patch.error : current.error,
                shared: (patch.sharedWithMembers ?? current.sharedWithMembers === 1) ? 1 : 0,
                at: now().toISOString(),
            });
            return toPlugin(q.get.get(ownerId, pluginId)!);
        },
        delete(ownerId: string, pluginId: string): boolean {
            return q.delete.run(ownerId, pluginId).changes > 0;
        },

        addEvent(
            ownerId: string,
            input: { pluginId: string; kind: PluginEventKind; version?: string | null; detail?: string | null },
        ): PluginEventRecord {
            const at = now().toISOString();
            const id = newId(now());
            q.eventInsert.run({
                id,
                ownerId,
                at,
                pluginId: input.pluginId,
                version: input.version ?? null,
                kind: input.kind,
                detail: input.detail ?? null,
            });
            return {
                id,
                ownerId,
                at,
                pluginId: input.pluginId,
                version: input.version ?? null,
                kind: input.kind,
                detail: input.detail ?? null,
            };
        },
        /** 新的在前;pluginId 为空时列出该 owner 的全部事件。 */
        listEvents(
            ownerId: string,
            page: { pluginId?: string | undefined; cursor?: string | undefined; limit: number },
        ): Page<PluginEventRecord> {
            const pid = page.pluginId ?? null;
            const rows = page.cursor
                ? (() => {
                      const c = decodeCursor(page.cursor, EventCursor);
                      return q.eventsAfter.all(ownerId, pid, pid, c.at, c.at, c.id, page.limit + 1);
                  })()
                : q.eventsFirst.all(ownerId, pid, pid, page.limit + 1);
            const items = rows.slice(0, page.limit);
            const last = items[items.length - 1];
            return {
                items,
                nextCursor: rows.length > page.limit && last ? encodeCursor({ at: last.at, id: last.id }) : null,
            };
        },
        /** 清理早于给定时刻的事件(保留 180 天,由每日维护任务调用)。 */
        purgeEvents(beforeIso: string): number {
            return q.eventsPurge.run(beforeIso).changes;
        },
    };
}

export type PluginRepository = ReturnType<typeof createPluginRepository>;
