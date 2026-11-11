// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置:每个 owner 一组键值(value_json),读取时与默认值合并,未知键忽略。
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '@fatcat-ai/shared';
import type { Connection } from './db.js';

type Key = keyof Settings;
const KEYS = Object.keys(DEFAULT_SETTINGS) as Key[];
/** 值为对象的键:读取与写入时与默认值 / 现有值浅合并。 */
const NESTED: readonly Key[] = ['memory', 'knowledgeBase', 'voice'];

export function createSettingsRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const q = {
        all: sqlite.prepare<[string], { key: string; valueJson: string }>(
            'SELECT key, value_json AS valueJson FROM settings WHERE owner_id = ?',
        ),
        upsert: sqlite.prepare(
            `INSERT INTO settings (owner_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (owner_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        ),
    };

    function get(ownerId: string): Settings {
        const settings: Settings = structuredClone(DEFAULT_SETTINGS);
        for (const row of q.all.all(ownerId)) {
            if (!(KEYS as string[]).includes(row.key)) continue;
            const key = row.key as Key;
            const value = JSON.parse(row.valueJson) as never;
            (settings as Record<Key, unknown>)[key] = NESTED.includes(key)
                ? { ...(DEFAULT_SETTINGS[key] as object), ...(value as object) }
                : value;
        }
        return settings;
    }

    return {
        get,
        /** 部分更新:只写入给出的键;memory、knowledgeBase、voice 与现有值浅合并。 */
        update(ownerId: string, patch: SettingsPatch): Settings {
            const current = get(ownerId);
            const at = now().toISOString();
            sqlite.transaction(() => {
                for (const key of KEYS) {
                    const value = patch[key];
                    if (value === undefined) continue;
                    const next = NESTED.includes(key) ? { ...(current[key] as object), ...(value as object) } : value;
                    q.upsert.run(ownerId, key, JSON.stringify(next), at);
                }
            })();
            return get(ownerId);
        },
    };
}
