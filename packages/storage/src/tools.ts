// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 工具框架的三张表:审批请求、预授权、审计日志(ADR 0010)。
import type {
    ApprovalWarning,
    ApprovalRequest,
    ApprovalStatus,
    AuditEntry,
    PreauthConstraint,
    Preauthorization,
    ToolRisk,
} from '@ai-personal/shared';
import { z } from 'zod';
import { decodeCursor, encodeCursor, type Page } from './cursor.js';
import type { Connection } from './db.js';
import { newId } from './ids.js';

interface ApprovalRow {
    callId: string;
    ownerId: string;
    runId: string;
    sessionId: string;
    toolName: string;
    risk: ToolRisk;
    summary: string;
    inputJson: string;
    preauthorizable: number;
    status: ApprovalStatus;
    createdAt: string;
    expiresAt: string;
    decidedAt: string | null;
    warningsJson: string | null;
}

interface PreauthRow {
    id: string;
    toolName: string;
    scope: 'session' | 'always';
    sessionId: string | null;
    constraintJson: string | null;
    createdAt: string;
    lastUsedAt: string | null;
}

interface AuditRow {
    id: string;
    at: string;
    action: AuditEntry['action'];
    toolName: string | null;
    risk: ToolRisk | null;
    callId: string | null;
    runId: string | null;
    sessionId: string | null;
    decision: AuditEntry['decision'];
    outcome: AuditEntry['outcome'];
    summary: string;
    inputDigest: string | null;
    error: string | null;
}

const APPROVAL_COLUMNS = `call_id AS callId, owner_id AS ownerId, run_id AS runId, session_id AS sessionId,
    tool_name AS toolName, risk, summary, input_json AS inputJson, preauthorizable, status,
    created_at AS createdAt, expires_at AS expiresAt, decided_at AS decidedAt, warnings_json AS warningsJson`;
const PREAUTH_COLUMNS = `id, tool_name AS toolName, scope, session_id AS sessionId, constraint_json AS constraintJson,
    created_at AS createdAt, last_used_at AS lastUsedAt`;
const AUDIT_COLUMNS = `id, at, action, tool_name AS toolName, risk, call_id AS callId, run_id AS runId,
    session_id AS sessionId, decision, outcome, summary, input_digest AS inputDigest, error`;

const pageCursor = z.object({ t: z.string(), id: z.string() });

function toApproval(row: ApprovalRow): ApprovalRequest {
    return {
        callId: row.callId,
        runId: row.runId,
        sessionId: row.sessionId,
        toolName: row.toolName,
        risk: row.risk,
        summary: row.summary,
        input: JSON.parse(row.inputJson) as unknown,
        status: row.status,
        preauthorizable: row.preauthorizable === 1,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        decidedAt: row.decidedAt,
        ...(row.warningsJson ? { warnings: JSON.parse(row.warningsJson) as ApprovalWarning[] } : {}),
    };
}

function toPreauth(row: PreauthRow): Preauthorization {
    return {
        id: row.id,
        toolName: row.toolName,
        scope: row.scope,
        sessionId: row.sessionId,
        constraint: row.constraintJson ? (JSON.parse(row.constraintJson) as PreauthConstraint) : null,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
    };
}

export interface NewApprovalRequest {
    callId: string;
    runId: string;
    sessionId: string;
    toolName: string;
    risk: ToolRisk;
    summary: string;
    input: unknown;
    preauthorizable: boolean;
    expiresAt: Date;
    /** core 生成的审批警告(ADR 0016 第 8 节);没有时省略。 */
    warnings?: ApprovalWarning[];
}

export type NewAuditEntry = Omit<AuditEntry, 'id' | 'at'>;

export function createToolRepositories(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const iso = () => now().toISOString();

    const q = {
        approvalInsert: sqlite.prepare(
            `INSERT INTO approval_requests (call_id, owner_id, run_id, session_id, tool_name, risk, summary, input_json,
               preauthorizable, status, created_at, expires_at, warnings_json)
             VALUES (@callId, @ownerId, @runId, @sessionId, @toolName, @risk, @summary, @inputJson,
               @preauthorizable, 'pending', @createdAt, @expiresAt, @warningsJson)`,
        ),
        approvalGet: sqlite.prepare<[string, string], ApprovalRow>(
            `SELECT ${APPROVAL_COLUMNS} FROM approval_requests WHERE owner_id = ? AND call_id = ?`,
        ),
        approvalDecide: sqlite.prepare<[ApprovalStatus, string, string, string]>(
            `UPDATE approval_requests SET status = ?, decided_at = ?
             WHERE owner_id = ? AND call_id = ? AND status = 'pending'`,
        ),
        approvalExpireAll: sqlite.prepare<[string]>(
            `UPDATE approval_requests SET status = 'expired', decided_at = ? WHERE status = 'pending'`,
        ),
        approvalFirst: sqlite.prepare<[string, string | null, string | null, number], ApprovalRow>(
            `SELECT ${APPROVAL_COLUMNS} FROM approval_requests
             WHERE owner_id = ? AND (? IS NULL OR status = ?)
             ORDER BY created_at DESC, call_id DESC LIMIT ?`,
        ),
        approvalAfter: sqlite.prepare<
            [string, string | null, string | null, string, string, string, number],
            ApprovalRow
        >(
            `SELECT ${APPROVAL_COLUMNS} FROM approval_requests
             WHERE owner_id = ? AND (? IS NULL OR status = ?) AND (created_at < ? OR (created_at = ? AND call_id < ?))
             ORDER BY created_at DESC, call_id DESC LIMIT ?`,
        ),
        preauthInsert: sqlite.prepare(
            `INSERT INTO tool_preauth (id, owner_id, tool_name, scope, session_id, constraint_json, created_at)
             VALUES (@id, @ownerId, @toolName, @scope, @sessionId, @constraintJson, @createdAt)`,
        ),
        preauthForTool: sqlite.prepare<[string, string, string], PreauthRow>(
            `SELECT ${PREAUTH_COLUMNS} FROM tool_preauth
             WHERE owner_id = ? AND tool_name = ? AND (scope = 'always' OR session_id = ?)
             ORDER BY created_at, id`,
        ),
        preauthList: sqlite.prepare<[string], PreauthRow>(
            `SELECT ${PREAUTH_COLUMNS} FROM tool_preauth WHERE owner_id = ? ORDER BY created_at DESC, id DESC`,
        ),
        preauthGet: sqlite.prepare<[string, string], PreauthRow>(
            `SELECT ${PREAUTH_COLUMNS} FROM tool_preauth WHERE owner_id = ? AND id = ?`,
        ),
        preauthDelete: sqlite.prepare<[string, string]>('DELETE FROM tool_preauth WHERE owner_id = ? AND id = ?'),
        preauthTouch: sqlite.prepare<[string, string]>('UPDATE tool_preauth SET last_used_at = ? WHERE id = ?'),
        auditInsert: sqlite.prepare(
            `INSERT INTO audit_log (id, owner_id, at, action, tool_name, risk, call_id, run_id, session_id, decision,
               outcome, summary, input_digest, error)
             VALUES (@id, @ownerId, @at, @action, @toolName, @risk, @callId, @runId, @sessionId, @decision,
               @outcome, @summary, @inputDigest, @error)`,
        ),
        auditFirst: sqlite.prepare<
            [string, string | null, string | null, string | null, string | null, string | null, string | null, number],
            AuditRow
        >(
            `SELECT ${AUDIT_COLUMNS} FROM audit_log
             WHERE owner_id = ? AND (? IS NULL OR tool_name = ?) AND (? IS NULL OR risk = ?) AND (? IS NULL OR at >= ?)
             ORDER BY at DESC, id DESC LIMIT ?`,
        ),
        auditAfter: sqlite.prepare<
            [
                string,
                string | null,
                string | null,
                string | null,
                string | null,
                string | null,
                string | null,
                string,
                string,
                string,
                number,
            ],
            AuditRow
        >(
            `SELECT ${AUDIT_COLUMNS} FROM audit_log
             WHERE owner_id = ? AND (? IS NULL OR tool_name = ?) AND (? IS NULL OR risk = ?) AND (? IS NULL OR at >= ?)
               AND (at < ? OR (at = ? AND id < ?))
             ORDER BY at DESC, id DESC LIMIT ?`,
        ),
        auditPurge: sqlite.prepare<[string]>('DELETE FROM audit_log WHERE at < ?'),
    };

    const approvals = {
        create(ownerId: string, input: NewApprovalRequest): ApprovalRequest {
            q.approvalInsert.run({
                callId: input.callId,
                ownerId,
                runId: input.runId,
                sessionId: input.sessionId,
                toolName: input.toolName,
                risk: input.risk,
                summary: input.summary,
                inputJson: JSON.stringify(input.input ?? null),
                preauthorizable: input.preauthorizable ? 1 : 0,
                createdAt: iso(),
                expiresAt: input.expiresAt.toISOString(),
                warningsJson: input.warnings?.length ? JSON.stringify(input.warnings) : null,
            });
            return approvals.get(ownerId, input.callId)!;
        },
        get(ownerId: string, callId: string): ApprovalRequest | null {
            const row = q.approvalGet.get(ownerId, callId);
            return row ? toApproval(row) : null;
        },
        /** 只有 pending 的请求能被决定;返回 false 表示已被处理(竞争中的后到者)或不存在。 */
        decide(ownerId: string, callId: string, status: Exclude<ApprovalStatus, 'pending'>): boolean {
            return q.approvalDecide.run(status, iso(), ownerId, callId).changes > 0;
        },
        /** 进程启动时:上次遗留的 pending 请求全部过期(ADR 0010 第 5 节)。 */
        expireAllPending(): number {
            return q.approvalExpireAll.run(iso()).changes;
        },
        list(
            ownerId: string,
            page: { cursor?: string | undefined; limit: number; status?: ApprovalStatus | undefined },
        ): Page<ApprovalRequest> {
            const status = page.status ?? null;
            const after = page.cursor ? decodeCursor(page.cursor, pageCursor) : null;
            const rows = after
                ? q.approvalAfter.all(ownerId, status, status, after.t, after.t, after.id, page.limit + 1)
                : q.approvalFirst.all(ownerId, status, status, page.limit + 1);
            const items = rows.slice(0, page.limit).map(toApproval);
            const last = items.at(-1);
            return {
                items,
                nextCursor:
                    rows.length > page.limit && last ? encodeCursor({ t: last.createdAt, id: last.callId }) : null,
            };
        },
    };

    const preauths = {
        create(
            ownerId: string,
            input: {
                toolName: string;
                scope: 'session' | 'always';
                sessionId: string | null;
                constraint: PreauthConstraint | null;
            },
        ): Preauthorization {
            const id = newId(now());
            q.preauthInsert.run({
                id,
                ownerId,
                toolName: input.toolName,
                scope: input.scope,
                sessionId: input.scope === 'session' ? input.sessionId : null,
                constraintJson: input.constraint ? JSON.stringify(input.constraint) : null,
                createdAt: iso(),
            });
            return toPreauth(q.preauthGet.get(ownerId, id)!);
        },
        /** 对某个工具可能生效的预授权:永久的,以及属于该会话的。 */
        forTool(ownerId: string, toolName: string, sessionId: string): Preauthorization[] {
            return q.preauthForTool.all(ownerId, toolName, sessionId).map(toPreauth);
        },
        list(ownerId: string): Preauthorization[] {
            return q.preauthList.all(ownerId).map(toPreauth);
        },
        get(ownerId: string, id: string): Preauthorization | null {
            const row = q.preauthGet.get(ownerId, id);
            return row ? toPreauth(row) : null;
        },
        delete(ownerId: string, id: string): boolean {
            return q.preauthDelete.run(ownerId, id).changes > 0;
        },
        touch(id: string): void {
            q.preauthTouch.run(iso(), id);
        },
    };

    const audit = {
        append(ownerId: string, entry: NewAuditEntry): AuditEntry {
            const row: AuditEntry = { id: newId(now()), at: iso(), ...entry };
            q.auditInsert.run({ ownerId, ...row });
            return row;
        },
        list(
            ownerId: string,
            page: {
                cursor?: string | undefined;
                limit: number;
                toolName?: string | undefined;
                risk?: ToolRisk | undefined;
                since?: string | undefined;
            },
        ): Page<AuditEntry> {
            const tool = page.toolName ?? null;
            const risk = page.risk ?? null;
            const since = page.since ?? null;
            const after = page.cursor ? decodeCursor(page.cursor, pageCursor) : null;
            const rows = after
                ? q.auditAfter.all(
                      ownerId,
                      tool,
                      tool,
                      risk,
                      risk,
                      since,
                      since,
                      after.t,
                      after.t,
                      after.id,
                      page.limit + 1,
                  )
                : q.auditFirst.all(ownerId, tool, tool, risk, risk, since, since, page.limit + 1);
            const items: AuditEntry[] = rows.slice(0, page.limit);
            const last = items.at(-1);
            return {
                items,
                nextCursor: rows.length > page.limit && last ? encodeCursor({ t: last.at, id: last.id }) : null,
            };
        },
        /** 删除早于 before 的审计记录(保留期由维护任务按设置调用,ADR 0010 第 6 节)。 */
        purgeBefore(before: Date): number {
            return q.auditPurge.run(before.toISOString()).changes;
        },
    };

    return { approvals, preauths, audit };
}
