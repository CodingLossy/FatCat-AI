// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories, openStorage, type Repositories } from '@ai-personal/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectCredential } from './secrets.js';
import { createMemoryService } from './service.js';

describe('detectCredential', () => {
    it.each([
        ['我的 OpenAI key 是 sk-proj-abcdefghijklmnop1234', 'api_key'],
        ['token: ghp_abcdefghijklmnopqrstuvwx12', 'access_token'],
        ['我的密码是 Hunter2!2026', 'password_assignment'],
        ['wifi password: correcthorse', 'password_assignment'],
        ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt'],
        ['-----BEGIN RSA PRIVATE KEY----- MIIE', 'private_key'],
        ['备用码 Zq8mR2vX7kL4pN9tW3yB6cJ1', 'high_entropy'],
    ])('拒存:%s', (text, kind) => {
        expect(detectCredential(text)).toBe(kind);
    });

    it.each([
        '用户常住杭州',
        'The user prefers concise answers in Chinese',
        '项目使用 AGPL-3.0-only 许可证',
        '密码学是一门有趣的学科',
    ])('放行普通内容:%s', (text) => {
        expect(detectCredential(text)).toBeNull();
    });
});

describe('MemoryService', () => {
    let dir: string;
    let close: () => void;
    let repos: Repositories;
    let ownerId: string;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'aip-memory-'));
        const { conn } = await openStorage({ dataDir: dir });
        close = () => conn.close();
        repos = createRepositories(conn);
        ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
    });
    afterEach(() => {
        close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('凭据拒存,且不落库', () => {
        const service = createMemoryService(repos);
        expect(service.save(ownerId, { text: '我的 key 是 sk-proj-abcdefghijklmnop1234' }, 'user_explicit')).toEqual({
            outcome: 'refused',
            reason: 'credential',
        });
        expect(repos.memories.list(ownerId, 10)).toEqual([]);
        // 验收 ③:全文搜索也找不到
        expect(service.search(ownerId, { query: 'sk-proj' }).items).toEqual([]);
    });

    it('敏感片段在落库前脱敏,原文搜不到', () => {
        const service = createMemoryService(repos);
        const r = service.save(ownerId, { text: '用户的手机号是 13812345678' }, 'user_explicit');
        const saved = repos.memories.get(ownerId, r.id!);
        expect(saved).toMatchObject({ text: '用户的手机号是 [手机号 ****5678]', sensitivity: 2 });
        expect(service.search(ownerId, { query: '13812345678' }).items).toEqual([]);
    });

    it('user.* 默认单值,第二次写入更替旧值;检索返回当前值', () => {
        const service = createMemoryService(repos);
        const a = service.save(ownerId, { text: '用户常住杭州', entityKey: 'user.location.city' }, 'user_explicit');
        const b = service.save(ownerId, { text: '用户搬到了上海', entityKey: 'user.location.city' }, 'user_explicit');
        expect(a.outcome).toBe('created');
        expect(b).toMatchObject({ outcome: 'superseded', supersededId: a.id });
        const found = service.search(ownerId, { query: '用户' });
        expect(found.items.map((m) => m.text)).toEqual(['用户搬到了上海']);
        expect(found.items[0]).toMatchObject({ origin: 'user_explicit', confidence: 0.9, cardinality: 'single' });
    });

    it('recall:有查询但没有命中时不再回退为最近的记忆(只有空查询才列出最近的)', () => {
        const service = createMemoryService(repos);
        service.save(ownerId, { text: '用户住在深圳。' }, 'user_explicit');
        expect(service.recall(ownerId, { query: '居住 城市 住址' }).items).toEqual([]);
        expect(service.recall(ownerId, { query: '' }).items[0]).toMatchObject({ text: '用户住在深圳。', score: 0 });
    });

    it('recall:query 为空时列出最近的 active 记忆,最多 20 条,不含已更替的', () => {
        const service = createMemoryService(repos);
        service.save(ownerId, { text: '用户常住杭州', entityKey: 'user.location.city' }, 'user_explicit');
        service.save(ownerId, { text: '用户搬到了上海', entityKey: 'user.location.city' }, 'user_explicit');
        for (let i = 0; i < 25; i++) service.save(ownerId, { text: `事实 ${i}` }, 'manual');
        for (const query of [undefined, '', '   ']) {
            const items = service.recall(ownerId, { query }).items;
            expect(items).toHaveLength(20);
            expect(items.every((m) => m.status === 'active')).toBe(true);
            expect(items.map((m) => m.text)).not.toContain('用户常住杭州');
        }
    });

    it('recall:有命中时与 search 结果一致', () => {
        const service = createMemoryService(repos);
        service.save(ownerId, { text: '用户住在深圳。' }, 'user_explicit');
        service.save(ownerId, { text: '用户喜欢喝茶' }, 'user_explicit');
        expect(service.recall(ownerId, { query: '深圳' })).toEqual(service.search(ownerId, { query: '深圳' }));
    });
});
