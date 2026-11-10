// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';

let t: TestDb;
const clock = fakeClock();

beforeEach(async () => {
    t = await createTestDb({ now: clock.now });
});
afterEach(() => t.cleanup());

const later = (ms: number) => new Date(clock.now().getTime() + ms);

describe('authSessions', () => {
    it('只返回未过期的会话,可续期与删除', () => {
        const { authSessions } = t.repos;
        authSessions.create({ idHash: 'h1', ownerId: t.ownerId, csrfHash: 'c1', expiresAt: later(1000) });
        expect(authSessions.getValid('h1')?.ownerId).toBe(t.ownerId);

        clock.tick(2000);
        expect(authSessions.getValid('h1')).toBeNull();
        authSessions.touch('h1', later(1000));
        expect(authSessions.getValid('h1')).not.toBeNull();

        authSessions.delete('h1');
        expect(authSessions.getValid('h1')).toBeNull();
    });

    it('deleteExpired 只删除过期会话', () => {
        const { authSessions } = t.repos;
        authSessions.create({ idHash: 'old', ownerId: t.ownerId, csrfHash: 'c', expiresAt: later(10) });
        authSessions.create({ idHash: 'new', ownerId: t.ownerId, csrfHash: 'c', expiresAt: later(100_000) });
        clock.tick(20);
        expect(authSessions.deleteExpired()).toBe(1);
        expect(authSessions.getValid('new')).not.toBeNull();
    });
});

describe('accessTokens', () => {
    it('创建后可按哈希找到;吊销后不可用,也不再出现在列表中', () => {
        const { accessTokens } = t.repos;
        const token = accessTokens.create({ ownerId: t.ownerId, name: 'cli', tokenHash: 'th', expiresAt: null });
        expect(token).not.toHaveProperty('tokenHash');
        expect(accessTokens.findUsable('th')?.id).toBe(token.id);
        expect(accessTokens.list(t.ownerId).map((x) => x.id)).toEqual([token.id]);

        expect(accessTokens.revoke(t.ownerId, token.id)).toBe(true);
        expect(accessTokens.revoke(t.ownerId, token.id)).toBe(false);
        expect(accessTokens.findUsable('th')).toBeNull();
        expect(accessTokens.list(t.ownerId)).toEqual([]);
    });

    it('过期令牌不可用;使用时记录 lastUsedAt', () => {
        const { accessTokens } = t.repos;
        const token = accessTokens.create({ ownerId: t.ownerId, name: 'x', tokenHash: 'exp', expiresAt: later(50) });
        accessTokens.touch(token.id);
        expect(accessTokens.list(t.ownerId)[0]?.lastUsedAt).not.toBeNull();
        clock.tick(100);
        expect(accessTokens.findUsable('exp')).toBeNull();
    });

    it('令牌哈希唯一', () => {
        const { accessTokens } = t.repos;
        accessTokens.create({ ownerId: t.ownerId, name: 'a', tokenHash: 'dup', expiresAt: null });
        expect(() => accessTokens.create({ ownerId: t.ownerId, name: 'b', tokenHash: 'dup', expiresAt: null })).toThrow(
            /UNIQUE/,
        );
    });
});
