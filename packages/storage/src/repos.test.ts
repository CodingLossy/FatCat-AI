// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { AgentEvent } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidCursorError } from './cursor.js';
import { newId } from './ids.js';
import { TABLE_COLUMNS } from './schema.js';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';

let t: TestDb;
const clock = fakeClock();

beforeEach(async () => {
    t = await createTestDb({ now: clock.auto() });
});
afterEach(() => t.cleanup());

const count = (table: string) => (t.conn.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const text = (s: string) => [{ type: 'text' as const, text: s }];

function seedConversation() {
    const { repos, ownerId } = t;
    const session = repos.sessions.create(ownerId, { title: 'hello' });
    const user = repos.messages.append(ownerId, session.id, { role: 'user', parts: text('hi'), status: 'complete' });
    const run = repos.runs.create(ownerId, { sessionId: session.id, inputMessageId: user.id });
    const answer = repos.messages.append(ownerId, session.id, {
        role: 'assistant',
        parts: [],
        status: 'streaming',
        runId: run.id,
    });
    return { session, user, run, answer };
}

function insertItem(id: string, title: string, summary: string | null = null) {
    const at = new Date().toISOString();
    t.conn.sqlite
        .prepare(
            `INSERT INTO items (id, owner_id, kind, type, source, title, summary, created_at, updated_at)
             VALUES (?, ?, 'content', 'memory.semantic', 'memory', ?, ?, ?, ?)`,
        )
        .run(id, t.ownerId, title, summary, at, at);
}

describe('owners', () => {
    it('1.0 只允许一个主人账户', () => {
        expect(t.repos.owners.count()).toBe(1);
        expect(() => t.repos.owners.create({ username: 'second', passwordHash: 'x' })).toThrow(/only one owner/);
    });
});

describe('sessions 与级联', () => {
    it('删除会话时级联删除消息、运行、事件与摘要', () => {
        const { session, run } = seedConversation();
        t.repos.events.append(t.ownerId, {
            sessionId: session.id,
            runId: run.id,
            event: { type: 'text-delta', runId: run.id, delta: 'x' },
        });
        t.conn.sqlite
            .prepare(
                `INSERT INTO session_summaries (id, session_id, from_seq, to_seq, summary, created_at)
                 VALUES (?, ?, 1, 2, 's', ?)`,
            )
            .run(newId(), session.id, new Date().toISOString());

        expect(t.repos.sessions.delete(t.ownerId, session.id)).toBe(true);
        for (const table of ['sessions', 'messages', 'runs', 'events', 'session_summaries']) {
            expect(count(table), table).toBe(0);
        }
    });

    it('删除模型配置档时会话的 modelProfileId 置空', () => {
        const at = new Date().toISOString();
        const profileId = newId();
        t.conn.sqlite
            .prepare(
                `INSERT INTO model_profiles (id, owner_id, label, kind, base_url, model, purpose_json, created_at, updated_at)
                 VALUES (?, ?, 'p', 'openai-compatible', 'http://127.0.0.1:11434/v1', 'm', '["chat"]', ?, ?)`,
            )
            .run(profileId, t.ownerId, at, at);
        const session = t.repos.sessions.create(t.ownerId, { modelProfileId: profileId });
        t.conn.sqlite.prepare('DELETE FROM model_profiles WHERE id = ?').run(profileId);
        expect(t.repos.sessions.get(t.ownerId, session.id)?.modelProfileId).toBeNull();
    });

    it('外键阻止引用不存在的会话', () => {
        expect(() =>
            t.repos.messages.append(t.ownerId, newId(), { role: 'user', parts: text('x'), status: 'complete' }),
        ).toThrow(/FOREIGN KEY/);
    });

    it('activeRunId 反映未结束的运行', () => {
        const { session, run } = seedConversation();
        expect(t.repos.sessions.get(t.ownerId, session.id)?.activeRunId).toBe(run.id);
        t.repos.runs.setStatus(run.id, 'succeeded');
        expect(t.repos.sessions.get(t.ownerId, session.id)?.activeRunId).toBeNull();
        expect(t.repos.runs.get(t.ownerId, run.id)?.finishedAt).not.toBeNull();
        expect(t.repos.runs.listActive(t.ownerId)).toEqual([]);
    });

    it('其他 owner 的 id 查不到数据', () => {
        const { session } = seedConversation();
        expect(t.repos.sessions.get(newId(), session.id)).toBeNull();
        expect(t.repos.sessions.delete(newId(), session.id)).toBe(false);
    });
});

describe('分页', () => {
    it('会话列表在翻页期间插入新会话也不重不漏', () => {
        const created = Array.from({ length: 7 }, (_, i) => t.repos.sessions.create(t.ownerId, { title: `s${i}` }));
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
            const page = t.repos.sessions.list(t.ownerId, { cursor, limit: 3 });
            seen.push(...page.items.map((s) => s.id));
            // 翻页过程中插入的新会话排在最前面,不会出现在后续页
            t.repos.sessions.create(t.ownerId, { title: `new${pages}` });
            cursor = page.nextCursor ?? undefined;
            pages++;
        } while (cursor);
        expect(seen).toEqual(created.map((s) => s.id).reverse());
        expect(pages).toBe(3);
    });

    it('消息按 seq 升序分页,seq 连续', () => {
        const { session } = seedConversation();
        for (let i = 0; i < 5; i++) {
            t.repos.messages.append(t.ownerId, session.id, { role: 'user', parts: text(`m${i}`), status: 'complete' });
        }
        const first = t.repos.messages.list(t.ownerId, session.id, { limit: 4 });
        const second = t.repos.messages.list(t.ownerId, session.id, { cursor: first.nextCursor!, limit: 4 });
        const seqs = [...first.items, ...second.items].map((m) => m.seq);
        expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(second.nextCursor).toBeNull();
    });

    it('非法游标抛出 InvalidCursorError', () => {
        expect(() => t.repos.sessions.list(t.ownerId, { cursor: 'not-a-cursor', limit: 10 })).toThrow(
            InvalidCursorError,
        );
    });
});

describe('messages', () => {
    it('同一会话内 clientMessageId 唯一,可据此查回原消息', () => {
        const { session } = seedConversation();
        const m = t.repos.messages.append(t.ownerId, session.id, {
            role: 'user',
            parts: text('again'),
            status: 'complete',
            clientMessageId: 'abc',
        });
        expect(t.repos.messages.findByClientMessageId(session.id, 'abc')?.id).toBe(m.id);
        expect(() =>
            t.repos.messages.append(t.ownerId, session.id, {
                role: 'user',
                parts: text('again'),
                status: 'complete',
                clientMessageId: 'abc',
            }),
        ).toThrow(/UNIQUE/);
    });

    it('更新正文、状态与用量', () => {
        const { answer } = seedConversation();
        t.repos.messages.update(answer.id, { parts: text('done'), status: 'complete', usage: { outputTokens: 3 } });
        const m = t.repos.messages.get(t.ownerId, answer.id)!;
        expect(m.parts).toEqual(text('done'));
        expect(m.status).toBe('complete');
        expect(m.usage).toEqual({ outputTokens: 3 });
    });
});

describe('events', () => {
    it('seq 单调递增,可按 owner 或运行补发', () => {
        const { session, run } = seedConversation();
        const append = (event: AgentEvent) =>
            t.repos.events.append(t.ownerId, { sessionId: session.id, runId: run.id, event });
        const e1 = append({ type: 'text-delta', runId: run.id, delta: 'a' });
        const e2 = append({ type: 'text-delta', runId: run.id, delta: 'b' });
        const e3 = append({ type: 'run-finished', runId: run.id, reason: 'stop' });
        expect(e2.seq).toBeGreaterThan(e1.seq);
        expect(t.repos.events.listAfter(t.ownerId, e1.seq, 10).map((e) => e.seq)).toEqual([e2.seq, e3.seq]);
        expect(t.repos.events.listRunAfter(t.ownerId, run.id, 0, 10).map((e) => e.event.type)).toEqual([
            'text-delta',
            'text-delta',
            'run-finished',
        ]);
        expect(t.repos.events.latestSeq(t.ownerId)).toBe(e3.seq);
    });

    it('compact 只删除早于截止时间且已结束的运行的 text-delta', () => {
        const a = seedConversation();
        const b = seedConversation();
        for (const r of [a, b]) {
            t.repos.events.append(t.ownerId, {
                sessionId: r.session.id,
                runId: r.run.id,
                event: { type: 'text-delta', runId: r.run.id, delta: 'x' },
            });
            t.repos.events.append(t.ownerId, {
                sessionId: r.session.id,
                runId: r.run.id,
                event: { type: 'run-finished', runId: r.run.id, reason: 'stop' },
            });
        }
        t.repos.runs.setStatus(a.run.id, 'succeeded'); // b 仍在运行
        expect(t.repos.events.compact(new Date('2100-01-01T00:00:00Z'))).toBe(1);
        expect(t.repos.events.listRunAfter(t.ownerId, a.run.id, 0, 10).map((e) => e.event.type)).toEqual([
            'run-finished',
        ]);
        expect(t.repos.events.listRunAfter(t.ownerId, b.run.id, 0, 10)).toHaveLength(2);
    });
});

describe('items 与记忆子集(ADR 0007)', () => {
    it('items_fts 用 trigram 检索中文,并随更新与删除同步', () => {
        const id = newId();
        insertItem(id, '居住地', '用户常住杭州市');
        const search = (q: string) =>
            t.conn.sqlite.prepare('SELECT rowid FROM items_fts WHERE items_fts MATCH ?').all(`"${q}"`);
        expect(search('住杭州')).toHaveLength(1);
        t.conn.sqlite.prepare("UPDATE items SET summary = '用户已搬到上海' WHERE id = ?").run(id);
        expect(search('住杭州')).toHaveLength(0);
        expect(search('到上海')).toHaveLength(1);
        t.conn.sqlite.prepare('DELETE FROM items WHERE id = ?').run(id);
        expect(search('到上海')).toHaveLength(0);
    });

    it('同一单值 entity_key 最多一条 active;先改旧值再插新值可以更替', () => {
        const insertFact = (itemId: string, status = 'active') =>
            t.conn.sqlite
                .prepare(
                    `INSERT INTO memory_facts (item_id, owner_id, mem_type, entity_key, cardinality, status, origin, created_at, updated_at)
                     VALUES (?, ?, 'semantic', 'user.location.city', 'single', ?, 'user_explicit', 'x', 'x')`,
                )
                .run(itemId, t.ownerId, status);
        const [a, b] = [newId(), newId()];
        insertItem(a, '杭州');
        insertItem(b, '上海');
        insertFact(a);
        expect(() => insertFact(b)).toThrow(/UNIQUE/);
        t.conn.sqlite.prepare("UPDATE memory_facts SET status = 'superseded' WHERE item_id = ?").run(a);
        expect(() => insertFact(b)).not.toThrow();
    });

    it('删除条目级联删除记忆与出处;删除会话只把出处中的引用置空', () => {
        const { session, user } = seedConversation();
        const id = newId();
        insertItem(id, '杭州');
        t.conn.sqlite
            .prepare(
                `INSERT INTO memory_facts (item_id, owner_id, mem_type, origin, created_at, updated_at)
                 VALUES (?, ?, 'semantic', 'user_explicit', 'x', 'x')`,
            )
            .run(id, t.ownerId);
        const insertSource = () =>
            t.conn.sqlite
                .prepare(
                    `INSERT INTO memory_sources (id, memory_id, session_id, user_message_id, created_at)
                     VALUES (?, ?, ?, ?, 'x')`,
                )
                .run(newId(), id, session.id, user.id);
        insertSource();
        t.repos.sessions.delete(t.ownerId, session.id);
        expect(t.conn.sqlite.prepare('SELECT session_id, user_message_id FROM memory_sources').get()).toEqual({
            session_id: null,
            user_message_id: null,
        });
        t.conn.sqlite.prepare('DELETE FROM items WHERE id = ?').run(id);
        expect(count('memory_facts')).toBe(0);
        expect(count('memory_sources')).toBe(0);
    });

    it('每个条目最多一条 primary 边', () => {
        const [root, a, b, child] = [newId(), newId(), newId(), newId()];
        for (const id of [root, a, b, child]) insertItem(id, id);
        const edge = t.conn.sqlite.prepare(
            'INSERT INTO item_edges (parent_id, child_id, rel, primary_edge) VALUES (?, ?, ?, ?)',
        );
        edge.run(a, child, 'contains', 1);
        expect(() => edge.run(b, child, 'contains', 1)).toThrow(/UNIQUE/);
        expect(() => edge.run(b, child, 'mentions', 0)).not.toThrow();
        t.conn.sqlite.prepare('DELETE FROM items WHERE id = ?').run(child);
        expect(count('item_edges')).toBe(0);
    });
});

describe('列清单与迁移 SQL 一致', () => {
    it.each(Object.entries(TABLE_COLUMNS))('%s', (name, columns) => {
        const dbColumns = (t.conn.sqlite.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(
            (c) => c.name,
        );
        expect([...columns].sort()).toEqual(dbColumns.sort());
    });

    it('覆盖了迁移中的全部普通表', () => {
        const dbTables = (
            t.conn.sqlite
                .prepare(
                    `SELECT name FROM sqlite_master WHERE type = 'table'
                     AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'items_fts%' AND name NOT LIKE 'kb_chunks_fts%'
                     AND name NOT LIKE 'mail_fts%' AND name <> 'schema_migrations'`,
                )
                .all() as { name: string }[]
        ).map((r) => r.name);
        expect(Object.keys(TABLE_COLUMNS).sort()).toEqual(dbTables.sort());
    });
});

describe('性能', () => {
    it('1 万条消息的会话,分页查询 P95 < 20ms', () => {
        const session = t.repos.sessions.create(t.ownerId);
        const insert = t.conn.sqlite.prepare(
            `INSERT INTO messages (id, session_id, owner_id, seq, role, parts_json, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'user', '[{"type":"text","text":"hello"}]', 'complete', 'x', 'x')`,
        );
        t.conn.sqlite.transaction(() => {
            for (let i = 1; i <= 10_000; i++) insert.run(newId(), session.id, t.ownerId, i);
        })();

        const timings: number[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 100; i++) {
            const start = performance.now();
            const page = t.repos.messages.list(t.ownerId, session.id, { cursor, limit: 50 });
            timings.push(performance.now() - start);
            cursor = page.nextCursor ?? undefined;
        }
        timings.sort((x, y) => x - y);
        expect(timings[Math.floor(timings.length * 0.95)]).toBeLessThan(20);
    });
});
