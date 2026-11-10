// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type {
    AgentEvent,
    EventEnvelope,
    Message,
    MessagePart,
    MessageRole,
    MessageStatus,
    Run,
    RunStatus,
    Session,
    Usage,
} from '@fatcat-ai/shared';
import { z } from 'zod';
import { createAuthRepositories } from './auth.js';
import { createMemoryRepository, createSummaryRepository } from './memory.js';
import { createMemoryReadRepository } from './memory-read.js';
import { createMemoryMaintenanceRepository } from './memory-maintenance.js';
import { createProfileRepository } from './profiles.js';
import { createSettingsRepository } from './settings.js';
import { createToolRepositories } from './tools.js';
import { createFsRootRepository } from './fs-roots.js';
import { createItemRepository } from './items.js';
import { createMcpServerRepository } from './mcp.js';
import { createEmbeddingStore } from './embeddings.js';
import { createKbRepository } from './kb.js';
import { createMailRepository } from './mail.js';
import { createMailCacheRepository } from './mail-cache.js';
import { decodeCursor, encodeCursor, type Page } from './cursor.js';
import type { Connection } from './db.js';
import { newId } from './ids.js';
import { selectList, type EventRow, type MessageRow, type OwnerRow, type RunRow, type SessionRow } from './schema.js';

export interface RepoOptions {
    now?: () => Date;
}

export interface AppendMessageInput {
    role: MessageRole;
    parts: MessagePart[];
    status: MessageStatus;
    runId?: string | null | undefined;
    parentMessageId?: string | null | undefined;
    modelProfileId?: string | null | undefined;
    clientMessageId?: string | null | undefined;
}

export interface PageRequest {
    cursor?: string | undefined;
    limit: number;
}

const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

const sessionCursor = z.object({ u: z.string(), id: z.string() });
const seqCursor = z.object({ s: z.number().int() });

function parseJson<T>(value: string | null): T | null {
    return value === null ? null : (JSON.parse(value) as T);
}

function toSession(row: SessionRow & { activeRunId: string | null }): Session {
    return {
        id: row.id,
        title: row.title,
        modelProfileId: row.modelProfileId,
        forkedFromSessionId: row.forkedFromSessionId,
        forkedFromMessageId: row.forkedFromMessageId,
        lastMessageAt: row.lastMessageAt,
        activeRunId: row.activeRunId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function toMessage(row: MessageRow): Message {
    return {
        id: row.id,
        sessionId: row.sessionId,
        seq: row.seq,
        role: row.role,
        parts: parseJson<MessagePart[]>(row.partsJson) ?? [],
        status: row.status,
        runId: row.runId,
        parentMessageId: row.parentMessageId,
        modelProfileId: row.modelProfileId,
        usage: parseJson<Usage>(row.usageJson),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function toRun(row: RunRow): Run {
    return {
        id: row.id,
        sessionId: row.sessionId,
        status: row.status,
        inputMessageId: row.inputMessageId,
        outputMessageId: row.outputMessageId,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
    };
}

function toEnvelope(row: EventRow): EventEnvelope {
    return {
        seq: row.seq,
        at: row.createdAt,
        sessionId: row.sessionId,
        event: JSON.parse(row.payloadJson) as AgentEvent,
    };
}

/** 各领域仓储的统一入口;其他包只通过这里访问数据库(ADR 0005)。SQL 全部使用参数绑定。 */
export function createRepositories(conn: Connection, options: RepoOptions = {}) {
    const { sqlite } = conn;
    const now = options.now ?? (() => new Date());
    const iso = () => now().toISOString();

    // ---------- owners ----------
    const ownerQ = {
        count: sqlite.prepare<[], { n: number }>('SELECT count(*) AS n FROM owners'),
        ids: sqlite.prepare<[], { id: string }>('SELECT id FROM owners ORDER BY created_at'),
        insert: sqlite.prepare(
            `INSERT INTO owners (id, username, password_hash, created_at, updated_at)
             VALUES (@id, @username, @passwordHash, @createdAt, @updatedAt)`,
        ),
        byId: sqlite.prepare<[string], OwnerRow>(`SELECT ${selectList('owners')} FROM owners WHERE id = ?`),
        byUsername: sqlite.prepare<[string], OwnerRow>(`SELECT ${selectList('owners')} FROM owners WHERE username = ?`),
    };

    const owners = {
        count(): number {
            return ownerQ.count.get()?.n ?? 0;
        },
        ids(): string[] {
            return ownerQ.ids.all().map((r) => r.id);
        },
        create(input: { username: string; passwordHash: string }) {
            const at = iso();
            const row = { id: newId(now()), ...input, createdAt: at, updatedAt: at };
            ownerQ.insert.run(row);
            return { id: row.id, username: row.username, createdAt: at };
        },
        get(id: string): OwnerRow | null {
            return ownerQ.byId.get(id) ?? null;
        },
        getByUsername(username: string): OwnerRow | null {
            return ownerQ.byUsername.get(username) ?? null;
        },
    };

    // ---------- sessions ----------
    const sessionSelect = `SELECT ${selectList('sessions')}, (
            SELECT r.id FROM runs r
            WHERE r.session_id = sessions.id AND r.finished_at IS NULL
            ORDER BY r.started_at DESC LIMIT 1
        ) AS "activeRunId"
        FROM sessions`;
    type SessionSelectRow = SessionRow & { activeRunId: string | null };

    const sessionQ = {
        insert: sqlite.prepare(
            `INSERT INTO sessions (id, owner_id, title, model_profile_id, created_at, updated_at, untrusted_at)
             VALUES (@id, @ownerId, @title, @modelProfileId, @createdAt, @updatedAt, @untrustedAt)`,
        ),
        get: sqlite.prepare<[string, string], SessionSelectRow>(`${sessionSelect} WHERE owner_id = ? AND id = ?`),
        first: sqlite.prepare<[string, number], SessionSelectRow>(
            `${sessionSelect} WHERE owner_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
        ),
        after: sqlite.prepare<[string, string, string, string, number], SessionSelectRow>(
            `${sessionSelect} WHERE owner_id = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))
             ORDER BY updated_at DESC, id DESC LIMIT ?`,
        ),
        update: sqlite.prepare(
            `UPDATE sessions SET
                title = coalesce(@title, title),
                model_profile_id = CASE WHEN @setProfile = 1 THEN @modelProfileId ELSE model_profile_id END,
                updated_at = @updatedAt
             WHERE owner_id = @ownerId AND id = @id`,
        ),
        delete: sqlite.prepare('DELETE FROM sessions WHERE owner_id = ? AND id = ?'),
        touch: sqlite.prepare('UPDATE sessions SET last_message_at = ?, updated_at = ? WHERE id = ?'),
        untrustedAt: sqlite.prepare<[string], { at: string | null }>(
            'SELECT untrusted_at AS at FROM sessions WHERE id = ?',
        ),
        markUntrusted: sqlite.prepare<[string, string]>(
            'UPDATE sessions SET untrusted_at = ? WHERE id = ? AND untrusted_at IS NULL',
        ),
    };

    const sessions = {
        create(
            ownerId: string,
            input: {
                title?: string | undefined;
                modelProfileId?: string | undefined;
                /** 以外部内容(如一封邮件)为上下文新建的会话,一开始就视为读过不可信内容(ADR 0016 第 7 节)。 */
                untrusted?: boolean | undefined;
            } = {},
        ): Session {
            const at = iso();
            const id = newId(now());
            sessionQ.insert.run({
                id,
                ownerId,
                title: input.title ?? '',
                modelProfileId: input.modelProfileId ?? null,
                createdAt: at,
                updatedAt: at,
                untrustedAt: input.untrusted ? at : null,
            });
            return sessions.get(ownerId, id)!;
        },
        get(ownerId: string, id: string): Session | null {
            const row = sessionQ.get.get(ownerId, id);
            return row ? toSession(row) : null;
        },
        /** 按 updatedAt 倒序;游标为最后一项的 (updatedAt, id)。 */
        list(ownerId: string, page: PageRequest): Page<Session> {
            const after = page.cursor ? decodeCursor(page.cursor, sessionCursor) : null;
            const rows = after
                ? sessionQ.after.all(ownerId, after.u, after.u, after.id, page.limit + 1)
                : sessionQ.first.all(ownerId, page.limit + 1);
            const items = rows.slice(0, page.limit).map(toSession);
            const last = items.at(-1);
            return {
                items,
                nextCursor: rows.length > page.limit && last ? encodeCursor({ u: last.updatedAt, id: last.id }) : null,
            };
        },
        update(
            ownerId: string,
            id: string,
            patch: { title?: string | undefined; modelProfileId?: string | null | undefined },
        ): Session | null {
            sessionQ.update.run({
                ownerId,
                id,
                title: patch.title ?? null,
                setProfile: patch.modelProfileId === undefined ? 0 : 1,
                modelProfileId: patch.modelProfileId ?? null,
                updatedAt: iso(),
            });
            return sessions.get(ownerId, id);
        },
        /** 删除会话;消息、运行、事件、摘要由外键级联删除。 */
        delete(ownerId: string, id: string): boolean {
            return sessionQ.delete.run(ownerId, id).changes > 0;
        },
        /** 会话第一次读到不可信内容的时间;之后整个会话都不再满足条件预授权(ADR 0016 第 7 节)。 */
        untrustedAt(id: string): string | null {
            return sessionQ.untrustedAt.get(id)?.at ?? null;
        },
        markUntrusted(id: string): void {
            sessionQ.markUntrusted.run(iso(), id);
        },
    };

    // ---------- messages ----------
    const messageSelect = `SELECT ${selectList('messages')} FROM messages`;
    const messageQ = {
        nextSeq: sqlite.prepare<[string], { s: number }>(
            'SELECT coalesce(max(seq), 0) + 1 AS s FROM messages WHERE session_id = ?',
        ),
        insert: sqlite.prepare(
            `INSERT INTO messages (id, session_id, owner_id, seq, role, parts_json, status, run_id,
                                   parent_message_id, model_profile_id, client_message_id, created_at, updated_at)
             VALUES (@id, @sessionId, @ownerId, @seq, @role, @partsJson, @status, @runId,
                     @parentMessageId, @modelProfileId, @clientMessageId, @createdAt, @updatedAt)`,
        ),
        byId: sqlite.prepare<[string], MessageRow>(`${messageSelect} WHERE id = ?`),
        byOwnerAndId: sqlite.prepare<[string, string], MessageRow>(`${messageSelect} WHERE owner_id = ? AND id = ?`),
        byClientId: sqlite.prepare<[string, string], MessageRow>(
            `${messageSelect} WHERE session_id = ? AND client_message_id = ?`,
        ),
        update: sqlite.prepare(
            `UPDATE messages SET
                parts_json = coalesce(@partsJson, parts_json),
                status = coalesce(@status, status),
                usage_json = CASE WHEN @setUsage = 1 THEN @usageJson ELSE usage_json END,
                run_id = CASE WHEN @setRun = 1 THEN @runId ELSE run_id END,
                updated_at = @updatedAt
             WHERE id = @id`,
        ),
        list: sqlite.prepare<[string, string, number, number], MessageRow>(
            `${messageSelect} WHERE owner_id = ? AND session_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
        ),
        before: sqlite.prepare<[string, string, number], MessageRow>(
            `${messageSelect} WHERE owner_id = ? AND session_id = ? AND seq < ? ORDER BY seq`,
        ),
        hasChild: sqlite.prepare<[string], { n: number }>(
            'SELECT count(*) AS n FROM messages WHERE parent_message_id = ?',
        ),
        interrupt: sqlite.prepare(`UPDATE messages SET status = 'error', updated_at = ? WHERE status = 'streaming'`),
    };

    /** 追加消息:seq 在同一事务内取「当前最大值 + 1」,并更新会话的 lastMessageAt。 */
    const appendMessage = sqlite.transaction(
        (ownerId: string, sessionId: string, input: AppendMessageInput): MessageRow => {
            const at = iso();
            const id = newId(now());
            messageQ.insert.run({
                id,
                sessionId,
                ownerId,
                seq: messageQ.nextSeq.get(sessionId)!.s,
                role: input.role,
                partsJson: JSON.stringify(input.parts),
                status: input.status,
                runId: input.runId ?? null,
                parentMessageId: input.parentMessageId ?? null,
                modelProfileId: input.modelProfileId ?? null,
                clientMessageId: input.clientMessageId ?? null,
                createdAt: at,
                updatedAt: at,
            });
            sessionQ.touch.run(at, at, sessionId);
            return messageQ.byId.get(id)!;
        },
    );

    const messages = {
        append(ownerId: string, sessionId: string, input: AppendMessageInput): Message {
            return toMessage(appendMessage(ownerId, sessionId, input));
        },
        get(ownerId: string, id: string): Message | null {
            const row = messageQ.byOwnerAndId.get(ownerId, id);
            return row ? toMessage(row) : null;
        },
        findByClientMessageId(sessionId: string, clientMessageId: string): Message | null {
            const row = messageQ.byClientId.get(sessionId, clientMessageId);
            return row ? toMessage(row) : null;
        },
        update(
            id: string,
            patch: { parts?: MessagePart[]; status?: MessageStatus; usage?: Usage | null; runId?: string | null },
        ): void {
            messageQ.update.run({
                id,
                partsJson: patch.parts === undefined ? null : JSON.stringify(patch.parts),
                status: patch.status ?? null,
                setUsage: patch.usage === undefined ? 0 : 1,
                usageJson: patch.usage ? JSON.stringify(patch.usage) : null,
                setRun: patch.runId === undefined ? 0 : 1,
                runId: patch.runId ?? null,
                updatedAt: iso(),
            });
        },
        /** 会话中 seq 小于 beforeSeq 的全部消息(组装模型上下文用),按 seq 升序。 */
        listBefore(ownerId: string, sessionId: string, beforeSeq: number): Message[] {
            return messageQ.before.all(ownerId, sessionId, beforeSeq).map(toMessage);
        },
        /** 是否已被重新生成的回复替代(有消息以它为 parentMessageId)。 */
        isSuperseded(id: string): boolean {
            return (messageQ.hasChild.get(id)?.n ?? 0) > 0;
        },
        /** 按 seq 升序;游标为最后一项的 seq。 */
        list(ownerId: string, sessionId: string, page: PageRequest): Page<Message> {
            const after = page.cursor ? decodeCursor(page.cursor, seqCursor).s : 0;
            const rows = messageQ.list.all(ownerId, sessionId, after, page.limit + 1);
            const items = rows.slice(0, page.limit).map(toMessage);
            const last = items.at(-1);
            return { items, nextCursor: rows.length > page.limit && last ? encodeCursor({ s: last.seq }) : null };
        },
    };

    // ---------- runs ----------
    const runSelect = `SELECT ${selectList('runs')} FROM runs`;
    const runQ = {
        insert: sqlite.prepare(
            `INSERT INTO runs (id, session_id, owner_id, status, input_message_id, started_at)
             VALUES (@id, @sessionId, @ownerId, 'queued', @inputMessageId, @startedAt)`,
        ),
        byId: sqlite.prepare<[string], RunRow>(`${runSelect} WHERE id = ?`),
        byOwnerAndId: sqlite.prepare<[string, string], RunRow>(`${runSelect} WHERE owner_id = ? AND id = ?`),
        setStatus: sqlite.prepare(
            `UPDATE runs SET
                status = @status,
                finished_at = CASE WHEN @terminal = 1 THEN @now ELSE finished_at END,
                output_message_id = CASE WHEN @setOutput = 1 THEN @outputMessageId ELSE output_message_id END,
                error_json = CASE WHEN @setError = 1 THEN @errorJson ELSE error_json END
             WHERE id = @id`,
        ),
        active: sqlite.prepare<[string], RunRow>(
            `${runSelect} WHERE owner_id = ? AND finished_at IS NULL ORDER BY started_at`,
        ),
        activeInSession: sqlite.prepare<[string, string], RunRow>(
            `${runSelect} WHERE owner_id = ? AND session_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1`,
        ),
        unfinished: sqlite.prepare<[], RunRow>(`${runSelect} WHERE finished_at IS NULL ORDER BY started_at`),
        latestForInput: sqlite.prepare<[string, string], RunRow>(
            `${runSelect} WHERE owner_id = ? AND input_message_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
        ),
    };

    const runs = {
        create(ownerId: string, input: { sessionId: string; inputMessageId: string }): Run {
            const id = newId(now());
            runQ.insert.run({ id, ownerId, ...input, startedAt: iso() });
            return toRun(runQ.byId.get(id)!);
        },
        get(ownerId: string, id: string): Run | null {
            const row = runQ.byOwnerAndId.get(ownerId, id);
            return row ? toRun(row) : null;
        },
        /** 进入 succeeded / failed / cancelled 时写入 finishedAt。 */
        setStatus(
            id: string,
            status: RunStatus,
            extra: { outputMessageId?: string | null; error?: unknown } = {},
        ): void {
            runQ.setStatus.run({
                id,
                status,
                terminal: TERMINAL_RUN_STATUSES.includes(status) ? 1 : 0,
                now: iso(),
                setOutput: extra.outputMessageId === undefined ? 0 : 1,
                outputMessageId: extra.outputMessageId ?? null,
                setError: extra.error === undefined ? 0 : 1,
                errorJson: extra.error === undefined ? null : JSON.stringify(extra.error),
            });
        },
        listActive(ownerId: string): Run[] {
            return runQ.active.all(ownerId).map(toRun);
        },
        /** 以某条用户消息为输入的最近一次运行(幂等提交时查回已有运行)。 */
        latestForInput(ownerId: string, inputMessageId: string): Run | null {
            const row = runQ.latestForInput.get(ownerId, inputMessageId);
            return row ? toRun(row) : null;
        },
        activeInSession(ownerId: string, sessionId: string): Run | null {
            const row = runQ.activeInSession.get(ownerId, sessionId);
            return row ? toRun(row) : null;
        },
        /** 进程启动时未结束的运行(上次进程异常退出时遗留),含 ownerId 以便补发事件。 */
        listUnfinished(): (Run & { ownerId: string })[] {
            return runQ.unfinished.all().map((row) => ({ ...toRun(row), ownerId: row.ownerId }));
        },
        /** 运行的原始错误(JSON)。 */
        error(id: string): unknown {
            const row = runQ.byId.get(id);
            return row?.errorJson ? (JSON.parse(row.errorJson) as unknown) : null;
        },
    };

    // ---------- events ----------
    const eventSelect = `SELECT ${selectList('events')} FROM events`;
    const eventQ = {
        insert: sqlite.prepare<[string, string | null, string | null, string, string, string], EventRow>(
            `INSERT INTO events (owner_id, session_id, run_id, type, payload_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             RETURNING ${selectList('events', 'events')}`,
        ),
        after: sqlite.prepare<[string, number, number], EventRow>(
            `${eventSelect} WHERE owner_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
        ),
        runAfter: sqlite.prepare<[string, string, number, number], EventRow>(
            `${eventSelect} WHERE owner_id = ? AND run_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
        ),
        bounds: sqlite.prepare<[string], { lo: number | null; hi: number | null }>(
            'SELECT min(seq) AS lo, max(seq) AS hi FROM events WHERE owner_id = ?',
        ),
        compact: sqlite.prepare(
            `DELETE FROM events WHERE type = 'text-delta'
             AND run_id IN (SELECT id FROM runs WHERE finished_at IS NOT NULL AND finished_at <= ?)`,
        ),
    };

    const events = {
        /** 持久化事件并返回带全局 seq 的信封(ADR 0004)。 */
        append(
            ownerId: string,
            input: { sessionId: string | null; runId: string | null; event: AgentEvent },
        ): EventEnvelope {
            const row = eventQ.insert.get(
                ownerId,
                input.sessionId,
                input.runId,
                input.event.type,
                JSON.stringify(input.event),
                iso(),
            )!;
            return toEnvelope(row);
        },
        /** 某 owner 在 afterSeq 之后的事件(WebSocket 补发)。 */
        listAfter(ownerId: string, afterSeq: number, limit: number): EventEnvelope[] {
            return eventQ.after.all(ownerId, afterSeq, limit).map(toEnvelope);
        },
        /** 某次运行在 afterSeq 之后的事件(SSE 续看)。 */
        listRunAfter(ownerId: string, runId: string, afterSeq: number, limit: number): EventEnvelope[] {
            return eventQ.runAfter.all(ownerId, runId, afterSeq, limit).map(toEnvelope);
        },
        latestSeq(ownerId: string): number {
            return eventQ.bounds.get(ownerId)?.hi ?? 0;
        },
        /** 最早仍可补发的 seq;小于它的请求无法完整补发。 */
        oldestSeq(ownerId: string): number | null {
            return eventQ.bounds.get(ownerId)?.lo ?? null;
        },
        /**
         * 删除已结束且早于 finishedBefore 的运行的 text-delta 事件(正文已完整保存在 messages,ADR 0005 第 6 节)。
         * 返回删除的行数。
         */
        compact(finishedBefore: Date): number {
            return eventQ.compact.run(finishedBefore.toISOString()).changes;
        },
    };

    const itemRepo = createItemRepository(conn, now);
    return {
        /** 在一个事务中执行(better-sqlite3 同步事务)。 */
        transaction<T>(fn: () => T): T {
            return sqlite.transaction(fn)();
        },
        /** 把所有 streaming 状态的消息标为 error(进程启动时收尾)。 */
        interruptStreamingMessages(): number {
            return messageQ.interrupt.run(iso()).changes;
        },
        owners,
        sessions,
        messages,
        runs,
        events,
        modelProfiles: createProfileRepository(conn, now),
        memories: createMemoryRepository(conn, now, itemRepo),
        memoryRead: createMemoryReadRepository(conn, now),
        memoryMaintenance: createMemoryMaintenanceRepository(conn),
        summaries: createSummaryRepository(conn, now),
        settings: createSettingsRepository(conn, now),
        ...createToolRepositories(conn, now),
        fsRoots: createFsRootRepository(conn, now),
        items: itemRepo,
        mcpServers: createMcpServerRepository(conn, now),
        embeddings: createEmbeddingStore(conn, now),
        kb: createKbRepository(conn, now),
        mail: createMailRepository(conn, now),
        mailCache: createMailCacheRepository(conn, now),
        ...createAuthRepositories(conn, now),
    };
}

export type Repositories = ReturnType<typeof createRepositories>;
