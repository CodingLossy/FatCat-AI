// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置:每个 owner 一组键值(value_json),读取时与默认值合并,未知键忽略。
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '@fatcat-ai/shared';
import type { Connection } from './db.js';

type Key = keyof Settings;
const KEYS = Object.keys(DEFAULT_SETTINGS) as Key[];
/** 值为对象的键:读取与写入时与默认值 / 现有值浅合并。 */
const NESTED: readonly Key[] = [
    'memory',
    'knowledgeBase',
    'voice',
    'network',
    'plugins',
    'browser',
    'systemOpen',
    'skills',
];
/**
 * 代理的 Skill 列表(ADR 0048 第 8 节):存在同一张 settings 表的这个键下,`{ [agentId]: string[] }`。
 * 它不是 Settings 的字段,不出现在 GET /api/v1/settings 里,只经 /api/v1/agents 读写。
 */
const AGENT_SKILLS_KEY = 'skillAgents';

export function createSettingsRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const q = {
        all: sqlite.prepare<[string], { key: string; valueJson: string }>(
            'SELECT key, value_json AS valueJson FROM settings WHERE owner_id = ?',
        ),
        one: sqlite.prepare<[string, string], { valueJson: string }>(
            'SELECT value_json AS valueJson FROM settings WHERE owner_id = ? AND key = ?',
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

    /** 全部代理的 Skill 列表;读不出时为空。 */
    function agentSkills(ownerId: string): Record<string, string[]> {
        const row = q.one.get(ownerId, AGENT_SKILLS_KEY);
        if (!row) return {};
        try {
            const value = JSON.parse(row.valueJson) as unknown;
            return value && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, string[]>)
                : {};
        } catch {
            return {};
        }
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
                    let next = NESTED.includes(key) ? { ...(current[key] as object), ...(value as object) } : value;
                    // 内置 Skill 的开关按 id 合并:只改请求里给出的那几个
                    if (key === 'skills' && patch.skills?.builtin) {
                        next = { builtin: { ...(current.skills?.builtin ?? {}), ...patch.skills.builtin } };
                    }
                    q.upsert.run(ownerId, key, JSON.stringify(next), at);
                }
            })();
            return get(ownerId);
        },
        agentSkills,
        /** 设置一个代理的 Skill 列表;null 或空数组时删除这一项(删除代理时也这样调用)。 */
        setAgentSkills(ownerId: string, agentId: string, skills: string[] | null): void {
            const all = agentSkills(ownerId);
            if (skills && skills.length > 0) all[agentId] = skills;
            else delete all[agentId];
            q.upsert.run(ownerId, AGENT_SKILLS_KEY, JSON.stringify(all), now().toISOString());
        },
    };
}
