// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-helpers.js';

let t: TestDb;
afterEach(() => t?.cleanup());

describe('channels 仓储(迁移 0014)', () => {
    it('新建默认停用;改动只影响给出的字段;按 owner 取数据', async () => {
        t = await createTestDb();
        const { channels } = t.repos;
        const c = channels.create(t.ownerId, { kind: 'wechat', label: '微信' });
        expect(c).toMatchObject({ enabled: false, notifyDegraded: false, sessionId: null, binding: null, config: {} });
        expect(channels.update(t.ownerId, c.id, { enabled: true })).toMatchObject({ enabled: true, label: '微信' });
        expect(channels.update(t.ownerId, 'missing', { enabled: true })).toBeNull();
        expect(channels.allEnabled().map((x) => x.id)).toEqual([c.id]);
        expect(channels.get('someone-else', c.id)).toBeNull();
        expect(channels.list(t.ownerId)).toHaveLength(1);

        const session = t.repos.sessions.create(t.ownerId, {});
        channels.setSession(c.id, session.id);
        t.repos.sessions.delete(t.ownerId, session.id);
        expect(channels.byId(c.id)?.sessionId).toBeNull();
    });

    it('绑定只有一个主人;配对码作废与失败计数;删除渠道级联删除', async () => {
        t = await createTestDb();
        const { channels } = t.repos;
        const c = channels.create(t.ownerId, { kind: 'wechat', label: '微信' });
        expect(channels.bind(c.id, 'u1')).toBe(true);
        expect(channels.bind(c.id, 'u2')).toBe(false);
        expect(channels.get(t.ownerId, c.id)?.binding?.externalUserId).toBe('u1');
        expect(channels.unbind(c.id)).toBe(true);
        expect(channels.unbind(c.id)).toBe(false);

        channels.setPairing(c.id, 'h1', new Date(Date.now() + 1000));
        channels.failPairing(c.id);
        expect(channels.getPairing(c.id)).toMatchObject({ codeHash: 'h1', failedAttempts: 1 });
        channels.setPairing(c.id, 'h2', new Date(Date.now() + 1000));
        expect(channels.getPairing(c.id)).toMatchObject({ codeHash: 'h2', failedAttempts: 0 });
        channels.deletePairing(c.id);
        expect(channels.getPairing(c.id)).toBeNull();

        expect(channels.recordInbound(c.id, 'm1')).toBe(true);
        expect(channels.recordInbound(c.id, 'm1')).toBe(false);
        expect(channels.pruneInbox(new Date(Date.now() + 1000))).toBe(1);

        channels.bind(c.id, 'u1');
        channels.setPairing(c.id, 'h3', new Date());
        channels.recordInbound(c.id, 'm2');
        expect(channels.delete(t.ownerId, c.id)).toBe(true);
        const left = t.conn.sqlite
            .prepare(
                `SELECT (SELECT COUNT(*) FROM channel_bindings) + (SELECT COUNT(*) FROM channel_pairings)
                   + (SELECT COUNT(*) FROM channel_inbox) AS n`,
            )
            .get() as { n: number };
        expect(left.n).toBe(0);
    });
});
