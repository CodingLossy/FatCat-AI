// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆维护任务的数据访问(《记忆模块补充设计》第 5 节;ADR 0007 第 5.7 节):按 item_id 游标分批读取,
// 每批在一个事务里写回;任务状态存进 jobs_state。计算规则在 packages/memory 中。
import type { Memory } from '@fatcat-ai/shared';
import type { Connection } from './db.js';

export interface MaintenanceRow {
    id: string;
    memType: Memory['memType'];
    subtype: Memory['subtype'];
    entityKey: string | null;
    cardinality: Memory['cardinality'];
    decisionState: string | null;
    pinned: number;
    tier: NonNullable<Memory['tier']>;
    decayScore: number;
    lastConfirmedAt: string | null;
    lastAccessedAt: string | null;
    updatedAt: string;
}

export interface JobState {
    lastRunAt: string | null;
    nextRunAt: string | null;
    state: Record<string, unknown>;
}

export function createMemoryMaintenanceRepository(conn: Connection) {
    const { sqlite } = conn;
    const q = {
        batch: sqlite.prepare<[string, string, number], MaintenanceRow>(
            `SELECT item_id AS id, mem_type AS memType, subtype, entity_key AS entityKey, cardinality,
                    decision_state AS decisionState, pinned, tier, decay_score AS decayScore,
                    last_confirmed_at AS lastConfirmedAt, last_accessed_at AS lastAccessedAt, updated_at AS updatedAt
             FROM memory_facts WHERE owner_id = ? AND item_id > ? AND status IN ('active','conflicted')
             ORDER BY item_id LIMIT ?`,
        ),
        setDecay: sqlite.prepare('UPDATE memory_facts SET decay_score = ? WHERE item_id = ?'),
        setTier: sqlite.prepare('UPDATE memory_facts SET tier = ? WHERE item_id = ?'),
        expire: sqlite.prepare<[string, string, string, number]>(
            `UPDATE memory_facts SET status = 'expired', updated_at = ?
             WHERE item_id IN (SELECT item_id FROM memory_facts
                               WHERE owner_id = ? AND status = 'active' AND valid_to IS NOT NULL AND valid_to < ?
                               LIMIT ?)`,
        ),
        jobState: sqlite.prepare<
            [string, string],
            { lastRunAt: string | null; nextRunAt: string | null; stateJson: string | null }
        >(
            `SELECT last_run_at AS lastRunAt, next_run_at AS nextRunAt, state_json AS stateJson
             FROM jobs_state WHERE owner_id = ? AND job = ?`,
        ),
        putJobState: sqlite.prepare(
            `INSERT INTO jobs_state (owner_id, job, last_run_at, next_run_at, state_json) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (owner_id, job) DO UPDATE SET last_run_at = excluded.last_run_at,
               next_run_at = excluded.next_run_at, state_json = excluded.state_json`,
        ),
    };

    return {
        /** 一批 active / conflicted 记忆(item_id 升序,从游标之后开始)。 */
        batch(ownerId: string, afterId: string, limit: number): MaintenanceRow[] {
            return q.batch.all(ownerId, afterId, limit);
        },
        /** 在一个事务里写回一批衰减分数与分层。 */
        apply(updates: { decay?: [string, number][]; tier?: [string, MaintenanceRow['tier']][] }): void {
            sqlite.transaction(() => {
                for (const [id, score] of updates.decay ?? []) q.setDecay.run(score, id);
                for (const [id, tier] of updates.tier ?? []) q.setTier.run(tier, id);
            })();
        },
        /** 把一批 valid_to 已过的 active 记录设为 expired,返回条数(为 0 时说明做完了)。 */
        expire(ownerId: string, nowIso: string, limit: number): number {
            return q.expire.run(nowIso, ownerId, nowIso, limit).changes;
        },
        jobState(ownerId: string, job: string): JobState | null {
            const row = q.jobState.get(ownerId, job);
            if (!row) return null;
            return {
                lastRunAt: row.lastRunAt,
                nextRunAt: row.nextRunAt,
                state: row.stateJson ? (JSON.parse(row.stateJson) as Record<string, unknown>) : {},
            };
        },
        putJobState(ownerId: string, job: string, value: JobState): void {
            q.putJobState.run(ownerId, job, value.lastRunAt, value.nextRunAt, JSON.stringify(value.state));
        },
    };
}

export type MemoryMaintenanceRepository = ReturnType<typeof createMemoryMaintenanceRepository>;
