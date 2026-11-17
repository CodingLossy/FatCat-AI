// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type {
    TaskAction,
    TaskErrorCode,
    TaskPolicy,
    TaskRunStatus,
    TaskRunTrigger,
    TaskTrigger,
} from '@fatcat-ai/shared';
import { z } from 'zod';
import { decodeCursor, encodeCursor, type Page } from './cursor.js';
import type { Connection } from './db.js';
import { newId } from './ids.js';

export interface TaskRecord {
    id: string;
    ownerId: string;
    name: string;
    kind: 'user' | 'system';
    status: 'draft' | 'active' | 'completed';
    enabled: boolean;
    trigger: TaskTrigger;
    action: TaskAction;
    policy: TaskPolicy;
    systemKey: string | null;
    /** 最近一次已触发(入队)的计划时刻;用来判断服务器关闭期间错过了哪些触发。 */
    lastFiredAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface TaskRunRecord {
    id: string;
    taskId: string;
    trigger: TaskRunTrigger;
    scheduledFor: string;
    status: TaskRunStatus;
    attempt: number;
    errorCode: TaskErrorCode | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
}

export interface SystemTaskSeed {
    key: string;
    name: string;
    trigger: TaskTrigger;
    action: TaskAction;
    policy: TaskPolicy;
}

export interface TaskPatchInput {
    name?: string | undefined;
    enabled?: boolean | undefined;
    trigger?: TaskTrigger | undefined;
    policy?: TaskPolicy | undefined;
    status?: TaskRecord['status'] | undefined;
}

interface TaskRow {
    id: string;
    ownerId: string;
    name: string;
    kind: 'user' | 'system';
    status: 'draft' | 'active' | 'completed';
    enabled: number;
    triggerJson: string;
    actionJson: string;
    policyJson: string;
    systemKey: string | null;
    lastFiredAt: string | null;
    createdAt: string;
    updatedAt: string;
}

interface RunRow {
    id: string;
    taskId: string;
    trigger: TaskRunTrigger;
    scheduledFor: string;
    status: TaskRunStatus;
    attempt: number;
    errorCode: TaskErrorCode | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
}

const TASK_SELECT = `SELECT id, owner_id AS ownerId, name, kind, status, enabled, trigger_json AS triggerJson,
    action_json AS actionJson, policy_json AS policyJson, system_key AS systemKey, last_fired_at AS lastFiredAt,
    created_at AS createdAt, updated_at AS updatedAt FROM tasks`;
const RUN_SELECT = `SELECT id, task_id AS taskId, trigger_reason AS trigger, scheduled_for AS scheduledFor, status,
    attempt, error_code AS errorCode, started_at AS startedAt, finished_at AS finishedAt, created_at AS createdAt
  FROM task_runs`;

const RunCursor = z.object({ at: z.string(), id: z.string() });

function toTask(row: TaskRow): TaskRecord {
    return {
        id: row.id,
        ownerId: row.ownerId,
        name: row.name,
        kind: row.kind,
        status: row.status,
        enabled: row.enabled === 1,
        trigger: JSON.parse(row.triggerJson) as TaskTrigger,
        action: JSON.parse(row.actionJson) as TaskAction,
        policy: JSON.parse(row.policyJson) as TaskPolicy,
        systemKey: row.systemKey,
        lastFiredAt: row.lastFiredAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/** 任务与运行记录(ADR 0033)。运行记录只存元数据:状态、错误码、时间,不存正文或模型输出。 */
export function createTaskRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const q = {
        list: sqlite.prepare<[string], TaskRow>(`${TASK_SELECT} WHERE owner_id = ? ORDER BY created_at, id`),
        active: sqlite.prepare<[], TaskRow>(
            `${TASK_SELECT} WHERE status = 'active' AND enabled = 1 ORDER BY created_at, id`,
        ),
        get: sqlite.prepare<[string, string], TaskRow>(`${TASK_SELECT} WHERE owner_id = ? AND id = ?`),
        getById: sqlite.prepare<[string], TaskRow>(`${TASK_SELECT} WHERE id = ?`),
        bySystemKey: sqlite.prepare<[string, string], TaskRow>(`${TASK_SELECT} WHERE owner_id = ? AND system_key = ?`),
        insert: sqlite.prepare(
            `INSERT INTO tasks (id, owner_id, name, kind, status, enabled, trigger_json, action_json, policy_json,
               system_key, created_at, updated_at)
             VALUES (@id, @ownerId, @name, @kind, 'active', @enabled, @trigger, @action, @policy, @systemKey, @at, @at)`,
        ),
        update: sqlite.prepare(
            `UPDATE tasks SET name = @name, status = @status, enabled = @enabled, trigger_json = @trigger,
               policy_json = @policy, updated_at = @at WHERE id = @id`,
        ),
        fired: sqlite.prepare(`UPDATE tasks SET last_fired_at = ? WHERE id = ?`),
        delete: sqlite.prepare(`DELETE FROM tasks WHERE owner_id = ? AND id = ? AND kind = 'user'`),
        insertRun: sqlite.prepare(
            `INSERT INTO task_runs (id, task_id, trigger_reason, scheduled_for, status, attempt, created_at)
             VALUES (@id, @taskId, @trigger, @scheduledFor, @status, @attempt, @at)`,
        ),
        getRun: sqlite.prepare<[string], RunRow>(`${RUN_SELECT} WHERE id = ?`),
        updateRun: sqlite.prepare(
            `UPDATE task_runs SET status = @status, error_code = @errorCode, started_at = COALESCE(@startedAt, started_at),
               finished_at = @finishedAt, attempt = @attempt WHERE id = @id`,
        ),
        lastRun: sqlite.prepare<[string], RunRow>(
            `${RUN_SELECT} WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        ),
        runsFirst: sqlite.prepare<[string, number], RunRow>(
            `${RUN_SELECT} WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        ),
        runsAfter: sqlite.prepare<[string, string, string, string, number], RunRow>(
            `${RUN_SELECT} WHERE task_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC LIMIT ?`,
        ),
        interrupt: sqlite.prepare(
            `UPDATE task_runs SET status = 'cancelled', error_code = 'internal', finished_at = ?
             WHERE status IN ('queued', 'running')`,
        ),
        prune: sqlite.prepare(
            `DELETE FROM task_runs WHERE task_id = ? AND id NOT IN (
               SELECT id FROM task_runs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
        ),
    };
    const iso = () => now().toISOString();

    return {
        list(ownerId: string, filter: { kind?: 'user' | 'system'; enabled?: boolean } = {}): TaskRecord[] {
            return q.list
                .all(ownerId)
                .map(toTask)
                .filter(
                    (t) =>
                        (filter.kind === undefined || t.kind === filter.kind) &&
                        (filter.enabled === undefined || t.enabled === filter.enabled),
                );
        },
        /** 所有主人的已启用任务;调度器启动与重新排期时读取。 */
        listActive(): TaskRecord[] {
            return q.active.all().map(toTask);
        },
        get(ownerId: string, id: string): TaskRecord | null {
            const row = q.get.get(ownerId, id);
            return row ? toTask(row) : null;
        },
        getById(id: string): TaskRecord | null {
            const row = q.getById.get(id);
            return row ? toTask(row) : null;
        },
        /** 内置系统任务:不存在才创建,已存在的保持用户改过的时间与开关不动。 */
        ensureSystem(ownerId: string, seed: SystemTaskSeed): TaskRecord {
            const existing = q.bySystemKey.get(ownerId, seed.key);
            if (existing) return toTask(existing);
            const id = newId(now());
            q.insert.run({
                id,
                ownerId,
                name: seed.name,
                kind: 'system',
                enabled: 1,
                trigger: JSON.stringify(seed.trigger),
                action: JSON.stringify(seed.action),
                policy: JSON.stringify(seed.policy),
                systemKey: seed.key,
                at: iso(),
            });
            return toTask(q.getById.get(id)!);
        },
        update(ownerId: string, id: string, patch: TaskPatchInput): TaskRecord | null {
            const current = q.get.get(ownerId, id);
            if (!current) return null;
            const task = toTask(current);
            q.update.run({
                id,
                name: patch.name ?? task.name,
                status: patch.status ?? task.status,
                enabled: (patch.enabled ?? task.enabled) ? 1 : 0,
                trigger: JSON.stringify(patch.trigger ?? task.trigger),
                policy: JSON.stringify(patch.policy ?? task.policy),
                at: iso(),
            });
            return toTask(q.getById.get(id)!);
        },
        markFired(id: string, scheduledFor: string): void {
            q.fired.run(scheduledFor, id);
        },
        /** 只删用户任务;系统任务不可删(返回 false)。 */
        delete(ownerId: string, id: string): boolean {
            return q.delete.run(ownerId, id).changes > 0;
        },

        createRun(input: {
            taskId: string;
            trigger: TaskRunTrigger;
            scheduledFor: string;
            status?: TaskRunStatus;
            attempt?: number;
        }): TaskRunRecord {
            const id = newId(now());
            q.insertRun.run({
                id,
                taskId: input.taskId,
                trigger: input.trigger,
                scheduledFor: input.scheduledFor,
                status: input.status ?? 'queued',
                attempt: input.attempt ?? 1,
                at: iso(),
            });
            return q.getRun.get(id)!;
        },
        getRun(id: string): TaskRunRecord | null {
            return q.getRun.get(id) ?? null;
        },
        updateRun(
            id: string,
            patch: {
                status: TaskRunStatus;
                errorCode?: TaskErrorCode | null;
                startedAt?: string | null;
                finishedAt?: string | null;
                attempt?: number;
            },
        ): TaskRunRecord | null {
            const current = q.getRun.get(id);
            if (!current) return null;
            q.updateRun.run({
                id,
                status: patch.status,
                errorCode: patch.errorCode ?? null,
                startedAt: patch.startedAt ?? null,
                finishedAt: patch.finishedAt ?? null,
                attempt: patch.attempt ?? current.attempt,
            });
            return q.getRun.get(id)!;
        },
        lastRun(taskId: string): TaskRunRecord | null {
            return q.lastRun.get(taskId) ?? null;
        },
        listRuns(taskId: string, page: { cursor?: string | undefined; limit: number }): Page<TaskRunRecord> {
            const rows = page.cursor
                ? (() => {
                      const c = decodeCursor(page.cursor, RunCursor);
                      return q.runsAfter.all(taskId, c.at, c.at, c.id, page.limit + 1);
                  })()
                : q.runsFirst.all(taskId, page.limit + 1);
            const items = rows.slice(0, page.limit);
            const last = items[items.length - 1];
            return {
                items,
                nextCursor: rows.length > page.limit && last ? encodeCursor({ at: last.createdAt, id: last.id }) : null,
            };
        },
        /** 启动时:上次关闭时还在排队或运行的记录标为已取消(不恢复执行,ADR 0033 第 3 节)。 */
        interruptUnfinished(): number {
            return q.interrupt.run(iso()).changes;
        },
        /** 每个任务只保留最近 keep 条运行记录。 */
        pruneRuns(taskId: string, keep: number): number {
            return q.prune.run(taskId, taskId, keep).changes;
        },
    };
}

export type TaskRepository = ReturnType<typeof createTaskRepository>;
