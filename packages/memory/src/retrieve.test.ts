// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    type Connection,
    createRepositories,
    type MemoryCandidate,
    openStorage,
    type Repositories,
} from '@ai-personal/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from './context.js';
import { createDigestBuilder } from './digest.js';
import { createRetriever, qualify, rerank } from './retrieve.js';
import { createMemoryService, type MemoryService } from './service.js';
import { estimateTokens } from './tokens.js';

const NOW = new Date('2026-11-05T00:00:00Z');

const candidate = (over: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
    id: '01M00000000000000000000000',
    text: '用户常住杭州',
    memType: 'semantic',
    subtype: null,
    entityKey: null,
    status: 'active',
    tier: 'active',
    domain: 'general',
    sensitivity: 0,
    confidence: 0.9,
    importance: 0.5,
    decayScore: 1,
    pinned: false,
    origin: 'user_explicit',
    decisionState: null,
    staleCount: 0,
    lastConfirmedAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...over,
});

describe('可信度说明与重排公式', () => {
    it.each([
        [{}, 'reliable'],
        [{ status: 'conflicted' as const }, 'conflicted'],
        [{ origin: 'extracted' as const, confidence: 0.55 }, 'inferred'],
        [{ lastConfirmedAt: '2026-04-01T00:00:00Z' }, 'possibly_stale'],
        [{ staleCount: 1 }, 'possibly_stale'],
    ])('%o → %s', (over, expected) => {
        expect(qualify(candidate(over), NOW)).toBe(expected);
    });

    it('score = rrf × (0.5 + 0.5·conf) × tierF × (0.7 + 0.3·decay) × pinned', () => {
        const rrf = 1 / 61;
        expect(rerank(rrf, candidate({ confidence: 1 }))).toBeCloseTo(rrf);
        expect(rerank(rrf, candidate({ confidence: 0, tier: 'cold', decayScore: 0 }))).toBeCloseTo(
            rrf * 0.5 * 0.6 * 0.7,
        );
        expect(rerank(rrf, candidate({ confidence: 1, tier: 'archive', pinned: true }))).toBeCloseTo(rrf * 0.3 * 1.2);
    });
});

describe('retrieve 与 digest', () => {
    let dir: string;
    let conn: Connection;
    let repos: Repositories;
    let memory: MemoryService;
    let ownerId: string;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'aip-memory-retrieve-'));
        ({ conn } = await openStorage({ dataDir: dir }));
        repos = createRepositories(conn);
        memory = createMemoryService(repos);
        ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
    });
    afterEach(() => {
        conn.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const write = (text: string, extra: Record<string, unknown> = {}) =>
        memory.write(ownerId, { text, ...extra }, { origin: 'user_explicit' }).id!;

    it('中文问句靠二字词命中,带可信度说明的固定格式,访问计数批量写入', async () => {
        const id = write('用户常住杭州', { entityKey: 'user.location.city' });
        write('用户喜欢喝龙井');
        const retriever = createRetriever({ repos, now: () => NOW, flushMs: 60_000 });
        const result = await retriever.retrieve(ownerId, { query: '我还住在杭州吗?' });
        expect(result.items.map((i) => i.id)).toEqual([id]);
        expect(result.items[0]).toMatchObject({ qualifier: 'reliable', channels: ['fts'] });
        expect(result.block).toContain(`[记忆 m:${id} | 事实 | 置信 0.90 | 用户明说 · `);
        expect(result.block).toContain('状态:可靠]\n用户常住杭州');
        // 1–2 字的查询走 LIKE
        expect((await retriever.retrieve(ownerId, { query: '龙井' })).items).toHaveLength(1);

        const count = () =>
            conn.sqlite
                .prepare<[string], { n: number }>('SELECT access_count AS n FROM memory_facts WHERE item_id = ?')
                .get(id)!.n;
        expect(count()).toBe(0);
        retriever.flush();
        expect(count()).toBe(1);
    });

    it('向量与图两路参与 RRF;向量不可用时只用 FTS', async () => {
        const a = write('用户的猫叫 Mochi');
        const b = write('用户每周三去游泳');
        const person = repos.items.upsert(ownerId, {
            source: 'contacts',
            sourceRef: 'p1',
            kind: 'content',
            type: 'person',
            title: '张三',
            parentId: null,
        }).id;
        conn.sqlite
            .prepare("INSERT INTO item_edges (parent_id, child_id, rel) VALUES (?, ?, 'mentions')")
            .run(person, b);

        const retriever = createRetriever({
            repos,
            vectors: () => Promise.resolve([{ itemId: a }, { itemId: 'not-a-memory' }]),
        });
        const result = await retriever.retrieve(ownerId, { query: '张三 和宠物' });
        expect(Object.fromEntries(result.items.map((i) => [i.id, i.channels]))).toEqual({
            [a]: ['vec'],
            [b]: ['graph'],
        });

        const failing = createRetriever({ repos, vectors: () => Promise.reject(new Error('down')) });
        expect((await failing.retrieve(ownerId, { query: 'Mochi' })).items.map((i) => i.id)).toEqual([a]);
    });

    it('向量召回超时:中止嵌入请求,只用全文结果', async () => {
        const a = write('用户的猫叫 Mochi');
        let aborted = false;
        const slow = createRetriever({
            repos,
            vectorTimeoutMs: 20,
            // 模拟一个不理会 signal 的慢嵌入接口
            vectors: (_owner, _query, _k, signal) => {
                signal.addEventListener('abort', () => (aborted = true));
                return new Promise((resolve) => setTimeout(() => resolve([{ itemId: 'late' }]), 5000).unref());
            },
        });
        const started = Date.now();
        const result = await slow.retrieve(ownerId, { query: 'Mochi' });
        expect(Date.now() - started).toBeLessThan(1000);
        expect(aborted).toBe(true);
        expect(result.items.map((i) => [i.id, i.channels])).toEqual([[a, ['fts']]]);
    });

    it('默认不含已更替的记录;问「以前」时带上', async () => {
        write('用户住在杭州', { entityKey: 'user.location.city' });
        write('用户搬到了上海', { entityKey: 'user.location.city' });
        const retriever = createRetriever({ repos });
        expect((await retriever.retrieve(ownerId, { query: '用户住在杭州' })).items).toEqual([]);
        expect((await retriever.retrieve(ownerId, { query: '我以前住在杭州吗' })).items.map((i) => i.status)).toEqual([
            'superseded',
        ]);
    });

    it('渠道过滤:群聊排除 sensitivity ≥ 1;sensitivity 2 只在私聊且原文命中时给出', async () => {
        write('我妈妈的生日是 5 月 3 日');
        write('用户的手机号是 13812345678');
        const retriever = createRetriever({ repos });
        expect((await retriever.retrieve(ownerId, { query: '生日' })).items).toHaveLength(1);
        expect((await retriever.retrieve(ownerId, { query: '生日' }, { channel: 'group' })).items).toEqual([]);
        expect((await retriever.retrieve(ownerId, { query: '手机号' })).items).toHaveLength(1);
        expect((await retriever.retrieve(ownerId, { query: '手机号' }, { channel: 'group' })).items).toEqual([]);
    });

    it('预算:超出时截断并注明未展示的条数;每条不超过 80 tokens', async () => {
        for (let i = 0; i < 20; i++) write(`用户的项目记录第 ${i} 条:${'很长的说明'.repeat(30)}`.slice(0, 200));
        const retriever = createRetriever({ repos });
        const result = await retriever.retrieve(ownerId, { query: '项目记录', tokenBudget: 300, limit: 20 });
        expect(result.omitted).toBeGreaterThan(0);
        expect(result.items.length + result.omitted).toBe(20);
        expect(estimateTokens(result.block)).toBeLessThanOrEqual(300 + 20);
        expect(result.block).toContain(`另有 ${result.omitted} 条相关记忆未展示`);
    });

    it('digest:置顶 → 画像 → 决策 → 冲突问题,在上限内;第一轮注入,记忆块去掉 digest 中已有的', async () => {
        const pinned = write('回答尽量简短');
        conn.sqlite.prepare('UPDATE memory_facts SET pinned = 1 WHERE item_id = ?').run(pinned);
        const city = write('用户常住杭州', { entityKey: 'user.location.city' });
        write('许可证用 AGPL', { subtype: 'decision', decisionState: 'accepted' });
        write('用户是后端工程师', { entityKey: 'user.role' });
        memory.write(ownerId, { text: '用户是产品经理', entityKey: 'user.role' }, { origin: 'extracted' });
        write('一条普通事实,不进 digest');

        const digest = createDigestBuilder({ repos, now: () => NOW });
        const d = digest.build(ownerId);
        expect(d.ids[0]).toBe(pinned);
        expect(d.ids).toContain(city);
        expect(d.body).toContain('许可证用 AGPL');
        expect(d.body).toContain('待向用户确认的矛盾');
        expect(d.body).not.toContain('普通事实');
        expect(d.openConflicts).toBe(1);
        expect(d.tokenEstimate).toBeLessThanOrEqual(400);
        expect(digest.get(ownerId).body).toBe(d.body);

        const context = createMemoryContext({ repos, retriever: createRetriever({ repos }), digest });
        const first = await context({ ownerId, query: '杭州', firstTurn: true });
        expect(first.messages).toHaveLength(1); // 杭州已经在 digest 里,记忆块为空
        expect(first.ids).toEqual(d.ids);
        const later = await context({ ownerId, query: '杭州', firstTurn: false });
        expect(later.ids).toEqual([city]);
    });

    it('digest 在上限很小时也不超出', () => {
        repos.settings.update(ownerId, { memory: { digestTokens: 100 } });
        for (let i = 0; i < 30; i++) {
            const id = write(`用户偏好第 ${i} 项:回答时先给结论再给理由`);
            conn.sqlite.prepare('UPDATE memory_facts SET pinned = 1 WHERE item_id = ?').run(id);
        }
        const d = createDigestBuilder({ repos }).build(ownerId);
        expect(d.tokenEstimate).toBeLessThanOrEqual(100);
        expect(d.ids.length).toBeGreaterThan(0);
    });
});
