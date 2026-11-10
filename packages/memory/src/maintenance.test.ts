// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    type Connection,
    createRepositories,
    type MaintenanceRow,
    openStorage,
    type Repositories,
} from '@ai-personal/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMaintenanceRunner, decayScore, nextTier } from './maintenance.js';
import { createRetriever } from './retrieve.js';
import { createMemoryService, type MemoryService } from './service.js';

const DAY = 86_400_000;
const T0 = new Date('2026-01-01T00:00:00Z');
const daysLater = (n: number) => new Date(T0.getTime() + n * DAY);

const row = (over: Partial<MaintenanceRow> = {}): MaintenanceRow => ({
    id: 'm1',
    memType: 'semantic',
    subtype: null,
    entityKey: null,
    cardinality: 'multi',
    decisionState: null,
    pinned: 0,
    tier: 'active',
    decayScore: 1,
    lastConfirmedAt: T0.toISOString(),
    lastAccessedAt: null,
    updatedAt: T0.toISOString(),
    ...over,
});

describe('衰减公式与分层规则(假时钟)', () => {
    it.each([
        ['semantic 一个半衰期', row(), 365, 0.5],
        ['episodic 两个半衰期', row({ memType: 'episodic' }), 60, 0.25],
        ['procedural 一个半衰期', row({ memType: 'procedural' }), 180, 0.5],
        ['done 的决策 90 天', row({ subtype: 'decision', decisionState: 'done' }), 90, 0.5],
        ['置顶不衰减', row({ memType: 'episodic', pinned: 1 }), 400, 1],
        ['画像类单值事实不衰减', row({ cardinality: 'single', entityKey: 'user.location.city' }), 400, 1],
        ['以最近一次访问为起点', row({ memType: 'episodic', lastAccessedAt: daysLater(30).toISOString() }), 60, 0.5],
    ])('%s', (_name, r, days, expected) => {
        expect(decayScore(r, daysLater(days))).toBeCloseTo(expected, 5);
    });

    it('active → cold(< 0.3 且 60 天未访问)→ archive(< 0.1 且 180 天未访问)', () => {
        expect(nextTier(row({ decayScore: 0.29 }), daysLater(59))).toBe('active');
        expect(nextTier(row({ decayScore: 0.29 }), daysLater(60))).toBe('cold');
        expect(nextTier(row({ decayScore: 0.31 }), daysLater(100))).toBe('active');
        expect(nextTier(row({ tier: 'cold', decayScore: 0.09 }), daysLater(179))).toBe('cold');
        expect(nextTier(row({ tier: 'cold', decayScore: 0.09 }), daysLater(180))).toBe('archive');
        expect(nextTier(row({ pinned: 1, decayScore: 0 }), daysLater(999))).toBe('active');
    });
});

describe('MaintenanceRunner', () => {
    let dir: string;
    let conn: Connection;
    let clock: Date;
    let repos: Repositories;
    let memory: MemoryService;
    let ownerId: string;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'aip-memory-maint-'));
        ({ conn } = await openStorage({ dataDir: dir }));
        clock = T0;
        repos = createRepositories(conn, { now: () => clock });
        memory = createMemoryService(repos);
        ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
    });
    afterEach(() => {
        conn.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const facts = (id: string) =>
        conn.sqlite
            .prepare<[string], { tier: string; decay: number; status: string }>(
                'SELECT tier, decay_score AS decay, status FROM memory_facts WHERE item_id = ?',
            )
            .get(id)!;

    it('decay → tier → expire;进入 archive 时删除向量;被访问后回到 active 并重新排队嵌入', async () => {
        const old = memory.write(
            ownerId,
            { text: '用户上个月去了一次苏州', memType: 'episodic' },
            { origin: 'user_explicit' },
        ).id!;
        const city = memory.write(
            ownerId,
            { text: '用户住在杭州', entityKey: 'user.location.city' },
            {
                origin: 'user_explicit',
            },
        ).id!;
        const trip = memory.write(
            ownerId,
            { text: '用户这周在出差', validFrom: T0.toISOString() },
            { origin: 'user_explicit' },
        ).id!;
        conn.sqlite
            .prepare('UPDATE memory_facts SET valid_to = ? WHERE item_id = ?')
            .run(daysLater(7).toISOString(), trip);

        const removed: string[] = [];
        const changed: string[] = [];
        const runner = createMaintenanceRunner({
            repos,
            now: () => clock,
            removeVectors: (id) => removed.push(id),
            onChanged: (o) => changed.push(o),
        });

        clock = daysLater(200); // episodic 半衰期 30 天:0.5^(200/30) ≈ 0.0098
        expect(await runner.runAll(ownerId)).toEqual({
            'memory.decay': 'done',
            'memory.tier': 'done',
            'memory.expire': 'done',
        });
        expect(facts(old)).toMatchObject({ tier: 'archive', status: 'active' });
        expect(facts(old).decay).toBeLessThan(0.01);
        expect(facts(city)).toMatchObject({ tier: 'active', decay: 1 });
        expect(facts(trip).status).toBe('expired');
        expect(removed).toEqual([old]);
        expect(changed).toEqual([ownerId]);

        // 同一天再运行:幂等
        expect(Object.values(await runner.runAll(ownerId))).toEqual(['already_done', 'already_done', 'already_done']);

        const reactivated: string[] = [];
        const retriever = createRetriever({ repos, onReactivated: (_o, id) => reactivated.push(id) });
        // LIKE 回退只扫 active 层,archive 层要靠 FTS(≥ 3 字的词)命中
        await retriever.retrieve(ownerId, { query: '一次苏州', includeArchive: true });
        retriever.flush();
        expect(facts(old).tier).toBe('active');
        expect(reactivated).toEqual([old]);
    });

    it('分批执行:有对话进行中或 RSS 超限时推迟,之后从游标继续', async () => {
        const ids = Array.from(
            { length: 5 },
            (_, i) =>
                memory.write(
                    ownerId,
                    { text: `用户第 ${i} 次去游泳`, memType: 'episodic' },
                    { origin: 'user_explicit' },
                ).id!,
        );
        clock = daysLater(30);
        let batches = 0;
        const runner = createMaintenanceRunner({
            repos,
            now: () => clock,
            batchSize: 2,
            removeVectors: () => undefined,
            isBusy: () => {
                batches++;
                return batches === 2; // 第二批之前「有对话」
            },
        });
        expect(await runner.run('memory.decay', ownerId)).toBe('postponed');
        const done = ids.filter((id) => facts(id).decay < 1);
        expect(done).toHaveLength(2);
        expect(await runner.run('memory.decay', ownerId)).toBe('done');
        expect(ids.every((id) => facts(id).decay === 0.5)).toBe(true);

        const heavy = createMaintenanceRunner({
            repos,
            now: () => daysLater(31),
            removeVectors: () => undefined,
            rss: () => 400 * 1024 * 1024,
        });
        expect(await heavy.run('memory.decay', ownerId)).toBe('postponed');
    });

    // 补充设计验收 ②:「我搬到上海了」→ 旧值 superseded,知识地图中只看到上海,详情能沿 supersedes 边看到历史链
    it('验收 ②:更替后默认视图只有新值,旧值在隐藏的历史版本下,并能沿 supersedes 边找到', () => {
        const hz = memory.write(
            ownerId,
            { text: '用户住在杭州', entityKey: 'user.location.city' },
            {
                origin: 'user_explicit',
            },
        ).id!;
        const sh = memory.write(
            ownerId,
            { text: '我搬到上海了', entityKey: 'user.location.city' },
            {
                origin: 'user_explicit',
            },
        ).id!;
        expect(repos.memories.get(ownerId, hz)?.status).toBe('superseded');

        const group = repos.items.bySource(ownerId, 'memory', 'memory:life:semantic')!;
        const visible = repos.items
            .children(ownerId, group.id, { limit: 50, sort: 'position' })
            .items.filter((i) => !(i.meta as { hidden?: boolean } | null)?.hidden);
        expect(visible.map((i) => i.summary ?? i.title)).toEqual(['我搬到上海了']);

        const history = repos.items.bySource(ownerId, 'memory', 'memory:life:semantic:history')!;
        expect(history.meta).toMatchObject({ hidden: true });
        expect(
            repos.items.children(ownerId, history.id, { limit: 50, sort: 'position' }).items.map((i) => i.id),
        ).toEqual([hz]);
        const chain = conn.sqlite
            .prepare<[string], { old: string }>(
                "SELECT child_id AS old FROM item_edges WHERE parent_id = ? AND rel = 'supersedes'",
            )
            .all(sh);
        expect(chain).toEqual([{ old: hz }]);
    });
});
