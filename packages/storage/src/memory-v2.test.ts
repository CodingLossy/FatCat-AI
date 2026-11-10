// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆 v2 的迁移与不变量(ADR 0007 第 5 节;补充设计第 9 节属性测试 (a)–(d))。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Connection } from './db.js';
import { newId } from './ids.js';
import type { NewMemory } from './memory.js';
import { migrate } from './migrate.js';
import { migrations } from './migrations/index.js';
import { createRepositories, type Repositories } from './repos.js';
import { VECTOR_TABLE } from './embeddings.js';

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'aip-memv2-'));
    dirs.push(dir);
    return dir;
}

/** 确定的伪随机数,失败时可以复现。 */
function rng(seed: number) {
    let x = seed;
    return () => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return x / 2147483648;
    };
}

const memory = (text: string, over: Partial<NewMemory> = {}): NewMemory => ({
    text,
    memType: 'semantic',
    subtype: null,
    entityKey: null,
    cardinality: 'multi',
    value: null,
    domain: 'general',
    sensitivity: 0,
    confidence: 0.7,
    origin: 'user_explicit',
    ...over,
});

/** 记忆树中计数与递归计算不一致的条目数(0 表示一致)。 */
const recountFixes = (repos: Repositories, ownerId: string) => repos.items.recount(ownerId);

/** (a) 每个单值键最多 1 条 active;(b) supersedes 链无环。 */
function checkInvariants(conn: Connection, repos: Repositories, ownerId: string): void {
    const dup = conn.sqlite
        .prepare(
            `SELECT entity_key AS k, count(*) AS n FROM memory_facts
             WHERE owner_id = ? AND cardinality = 'single' AND status = 'active' AND entity_key IS NOT NULL
             GROUP BY entity_key HAVING n > 1`,
        )
        .all(ownerId);
    expect(dup).toEqual([]);

    const next = new Map(
        (
            conn.sqlite
                .prepare('SELECT item_id AS id, supersedes_id AS s FROM memory_facts WHERE supersedes_id IS NOT NULL')
                .all() as { id: string; s: string }[]
        ).map((r) => [r.id, r.s]),
    );
    for (const start of next.keys()) {
        const seen = new Set<string>();
        let cur: string | undefined = start;
        while (cur) {
            expect(seen.has(cur)).toBe(false);
            seen.add(cur);
            cur = next.get(cur);
        }
    }
    // (c) 记忆子树计数与递归计算一致
    expect(recountFixes(repos, ownerId)).toBe(0);
}

describe('v1 → v2 数据迁移', () => {
    it('用 M1 格式的数据库迁移:条数与正文不变,建好导航树与计数,推断更替链,迁移前有备份', async () => {
        const dir = tempDir();
        const conn = openDatabase(join(dir, 'db.sqlite'));
        // 先只执行 M1 的迁移,并按 M1 的写法插入数据(没有导航树边)
        await migrate(conn.sqlite, migrations.slice(0, 1));
        const ownerId = newId();
        const at = (n: number) => `2026-10-0${n}T00:00:00.000Z`;
        conn.sqlite
            .prepare(
                "INSERT INTO owners (id, username, password_hash, created_at, updated_at) VALUES (?, 'o', 'x', ?, ?)",
            )
            .run(ownerId, at(1), at(1));
        const insert = (text: string, f: Record<string, unknown>, n: number) => {
            const id = newId(new Date(at(n)));
            conn.sqlite
                .prepare(
                    `INSERT INTO items (id, owner_id, kind, type, source, title, summary, created_at, updated_at)
                     VALUES (?, ?, 'content', ?, 'memory', ?, ?, ?, ?)`,
                )
                .run(id, ownerId, `memory.${String(f.memType)}`, text.slice(0, 40), text, at(n), at(n));
            conn.sqlite
                .prepare(
                    `INSERT INTO memory_facts (item_id, owner_id, mem_type, subtype, entity_key, cardinality, status,
                       domain, origin, created_at, updated_at)
                     VALUES (@id, @ownerId, @memType, @subtype, @entityKey, @cardinality, @status, @domain,
                       'user_explicit', @at, @at)`,
                )
                .run({
                    id,
                    ownerId,
                    subtype: null,
                    entityKey: null,
                    cardinality: 'multi',
                    status: 'active',
                    domain: 'general',
                    at: at(n),
                    ...f,
                });
            return id;
        };
        const hz = insert(
            '用户住在杭州',
            {
                memType: 'semantic',
                entityKey: 'user.location.city',
                cardinality: 'single',
                status: 'superseded',
                domain: 'life',
            },
            1,
        );
        const sh = insert(
            '用户住在上海',
            { memType: 'semantic', entityKey: 'user.location.city', cardinality: 'single', domain: 'life' },
            2,
        );
        const dec = insert('采用 AGPL', { memType: 'semantic', subtype: 'decision', domain: 'work' }, 3);
        const ep = insert('上周去了北京', { memType: 'episodic' }, 4);
        conn.sqlite
            .prepare('INSERT INTO memory_sources (id, memory_id, created_at) VALUES (?, ?, ?)')
            .run(newId(), sh, at(2));
        const before = conn.sqlite
            .prepare(
                'SELECT item_id AS id, i.summary AS text FROM memory_facts f JOIN items i ON i.id = f.item_id ORDER BY item_id',
            )
            .all();

        const result = await migrate(conn.sqlite, migrations, { backupDir: join(dir, 'backups') });
        expect(result.applied).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
        expect(conn.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);

        const after = conn.sqlite
            .prepare(
                'SELECT item_id AS id, i.summary AS text FROM memory_facts f JOIN items i ON i.id = f.item_id ORDER BY item_id',
            )
            .all();
        expect(after).toEqual(before);

        const repos = createRepositories(conn);
        expect(repos.memories.get(ownerId, sh)).toMatchObject({ tier: 'active', supersedesId: hz, pinned: false });
        expect(repos.memories.get(ownerId, sh)!.lastConfirmedAt).toBe(at(2));
        const titles = (id: string) => repos.items.ancestors(ownerId, id).map((a) => a.title);
        expect(titles(sh)).toEqual(['记忆', '生活', '事实']);
        expect(titles(hz)).toEqual(['记忆', '生活', '事实', '历史版本']);
        expect(titles(dec)).toEqual(['记忆', '工作', '决策']);
        expect(titles(ep)).toEqual(['记忆', '通用', '经历']);
        const root = repos.items.bySource(ownerId, 'memory', 'memory')!;
        expect(root).toMatchObject({ childCount: 3, descendantCount: 4 + 3 + 3 + 1 });
        expect(repos.items.bySource(ownerId, 'memory', 'memory:life:semantic:history')!.meta).toEqual({ hidden: true });
        const edge = conn.sqlite
            .prepare(
                "SELECT primary_edge AS p FROM item_edges WHERE parent_id = ? AND child_id = ? AND rel = 'supersedes'",
            )
            .get(sh, hz);
        expect(edge).toEqual({ p: 0 });
        checkInvariants(conn, repos, ownerId);
        conn.close();
    });
});

describe('属性测试:随机写入 / 更替 / 改域 / 撤回 / 忘记', () => {
    it('(a) 单值键最多 1 条 active;(b) 更替链无环;(c) 计数与递归计算一致;(d) 忘记后来源、反馈、冲突、向量全部清空', async () => {
        const dir = tempDir();
        const conn = openDatabase(join(dir, 'db.sqlite'));
        await migrate(conn.sqlite, migrations);
        const repos = createRepositories(conn);
        const ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
        const random = rng(20261104);
        const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
        const keys = ['user.location.city', 'user.employer', 'pref.tone'];
        const domains = ['work', 'life', 'general'] as const;
        const live: string[] = [];
        let vectorsReady = false;

        const attachExtras = (id: string, peer: string | undefined) => {
            const at = new Date().toISOString();
            conn.sqlite
                .prepare('INSERT INTO memory_sources (id, memory_id, created_at) VALUES (?, ?, ?)')
                .run(newId(), id, at);
            conn.sqlite
                .prepare("INSERT INTO memory_feedback (id, memory_id, signal, created_at) VALUES (?, ?, 'helpful', ?)")
                .run(newId(), id, at);
            if (peer) {
                conn.sqlite
                    .prepare(
                        `INSERT INTO memory_conflicts (id, owner_id, a_id, b_id, kind, created_at)
                         VALUES (?, ?, ?, ?, 'semantic_contradiction', ?)`,
                    )
                    .run(newId(), ownerId, id, peer, at);
            }
            repos.embeddings.enqueue(ownerId, id, 0, `vector for ${id}`);
            if (!vectorsReady)
                vectorsReady = repos.embeddings.ensureVectorTable({ profileId: null, model: 'm', dimensions: 2 });
            repos.embeddings.complete(repos.embeddings.due(10), [Float32Array.from([random(), random()])], 'm');
        };

        for (let step = 0; step < 300; step++) {
            const r = random();
            if (r < 0.45 || live.length === 0) {
                const single = random() < 0.6;
                const out = repos.memories.save(
                    ownerId,
                    memory(`记忆 ${step}`, {
                        entityKey: single ? pick(keys) : null,
                        cardinality: single ? 'single' : 'multi',
                        domain: pick(domains),
                        memType: pick(['semantic', 'episodic', 'procedural'] as const),
                        subtype: random() < 0.2 ? 'decision' : null,
                    }),
                );
                live.push(out.id);
                if (random() < 0.5) attachExtras(out.id, live.length > 1 ? live[0] : undefined);
            } else if (r < 0.6) {
                repos.memories.update(ownerId, pick(live), { domain: pick(domains) });
            } else if (r < 0.7) {
                repos.memories.update(ownerId, pick(live), { retract: true });
            } else if (r < 0.85) {
                const id = pick(live);
                expect(repos.memories.delete(ownerId, id)).toBe(true);
                live.splice(live.indexOf(id), 1);
                // (d) 级联清理
                for (const table of ['memory_sources', 'memory_feedback']) {
                    expect(
                        conn.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE memory_id = ?`).get(id),
                    ).toEqual({ n: 0 });
                }
                expect(
                    conn.sqlite
                        .prepare('SELECT count(*) AS n FROM memory_conflicts WHERE a_id = ? OR b_id = ?')
                        .get(id, id),
                ).toEqual({ n: 0 });
                expect(conn.sqlite.prepare('SELECT count(*) AS n FROM embeddings WHERE item_id = ?').get(id)).toEqual({
                    n: 0,
                });
            } else {
                // 同一键的多次更替
                repos.memories.save(ownerId, memory(`更替 ${step}`, { entityKey: pick(keys), cardinality: 'single' }));
            }
            if (step % 25 === 0) checkInvariants(conn, repos, ownerId);
        }
        checkInvariants(conn, repos, ownerId);
        // 向量行与映射一致:每个嵌入都有向量,没有孤立的向量行
        const embedded = (conn.sqlite.prepare('SELECT count(*) AS n FROM embeddings').get() as { n: number }).n;
        const vectors = (conn.sqlite.prepare(`SELECT count(*) AS n FROM ${VECTOR_TABLE}`).get() as { n: number }).n;
        expect(vectors).toBe(embedded);
        conn.close();
    });
});
