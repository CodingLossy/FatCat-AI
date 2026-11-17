// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type {
    TaskAction,
    TaskErrorCode,
    TaskOutput,
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
    outputs: TaskOutput[];
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
    sessionId: string | null;
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
    outputs?: TaskOutput[] | undefined;
    action?: TaskAction | undefined;
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
    outputsJson: string;
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
    sessionId: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
}

const TASK_SELECT = `SELECT id, owner_id AS ownerId, name, kind, status, enabled, trigger_json AS triggerJson,
    action_json AS actionJson, outputs_json AS outputsJson, policy_json AS policyJson, system_key AS systemKey, last_fired_at AS lastFiredAt,
    created_at AS createdAt, updated_at AS updatedAt FROM tasks`;
const RUN_SELECT = `SELECT id, task_id AS taskId, trigger_reason AS trigger, scheduled_for AS scheduledFor, status,
    attempt, error_code AS errorCode, session_id AS sessionId, started_at AS startedAt, finished_at AS finishedAt, created_at AS createdAt
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
        outputs: JSON.parse(row.outputsJson) as TaskOutput[],
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
        insertUser: sqlite.prepare(
            `INSERT INTO tasks (id, owner_id, name, kind, status, enabled, trigger_json, action_json, outputs_json,
               policy_json, created_at, updated_at)
             VALUES (@id, @ownerId, @name, 'user', @status, @enabled, @trigger, @action, @outputs, @policy, @at, @at)`,
        ),
        pruneDrafts: sqlite.prepare(`DELETE FROM tasks WHERE status = 'draft' AND kind = 'user' AND updated_at < ?`),
        update: sqlite.prepare(
            `UPDATE tasks SET name = @name, status = @status, enabled = @enabled, trigger_json = @trigger,
               action_json = @action, outputs_json = @outputs, policy_json = @policy, updated_at = @at WHERE id = @id`,
        ),
        setRunSession: sqlite.prepare(`UPDATE task_runs SET session_id = ?, run_id = ? WHERE id = ?`),
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
        tokenGet: sqlite.prepare<[string], { tokenHash: string }>(
            `SELECT token_hash AS tokenHash FROM task_webhook_tokens WHERE task_id = ?`,
        ),
        tokenSet: sqlite.prepare(
            `INSERT INTO task_webhook_tokens (task_id, token_hash, created_at) VALUES (?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at,
               last_used_at = NULL`,
        ),
        tokenUsed: sqlite.prepare(`UPDATE task_webhook_tokens SET last_used_at = ? WHERE task_id = ?`),
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
        createUser(
            ownerId: string,
            input: {
                name: string;
                trigger: TaskTrigger;
                action: TaskAction;
                outputs: TaskOutput[];
                policy: TaskPolicy;
            },
            draft = false,
        ): TaskRecord {
            const id = newId(now());
            q.insertUser.run({
                id,
                status: draft ? 'draft' : 'active',
                enabled: draft ? 0 : 1,
                ownerId,
                name: input.name,
                trigger: JSON.stringify(input.trigger),
                action: JSON.stringify(input.action),
                outputs: JSON.stringify(input.outputs),
                policy: JSON.stringify(input.policy),
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
                action: JSON.stringify(patch.action ?? task.action),
                outputs: JSON.stringify(patch.outputs ?? task.outputs),
                policy: JSON.stringify(patch.policy ?? task.policy),
                at: iso(),
            });
            return toTask(q.getById.get(id)!);
        },
        /** 删除超过保留期仍未确认的草稿(自然语言创建,ADR 0036)。 */
        pruneDrafts(olderThanIso: string): number {
            return q.pruneDrafts.run(olderThanIso).changes;
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
        /** 记下这次运行用的任务会话与 Agent 运行 id。 */
        setRunSession(id: string, sessionId: string, agentRunId: string): void {
            q.setRunSession.run(sessionId, agentRunId, id);
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
        /** Webhook 令牌的哈希(只存哈希);没有令牌时为 null。 */
        webhookTokenHash(taskId: string): string | null {
            return q.tokenGet.get(taskId)?.tokenHash ?? null;
        },
        setWebhookTokenHash(taskId: string, hash: string): void {
            q.tokenSet.run(taskId, hash, iso());
        },
        touchWebhookToken(taskId: string): void {
            q.tokenUsed.run(iso(), taskId);
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
