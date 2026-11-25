// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 账户与角色(ADR 0053 第 2、6 节):setup 建的账户是管理员,/auth/me 带角色;requireAdmin 对成员和停用的管理员回 403。
import { Me } from '@fatcat-ai/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from './auth/crypto.js';
import { requireAdmin } from './auth/middleware.js';
import type { AppEnv } from './env.js';
import { ApiError } from './errors.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;

beforeEach(async () => {
    s = await createTestServer();
});
afterEach(async () => {
    await s.cleanup();
});

const login = async (username: string) => {
    const res = await s.app.request('/api/v1/auth/login', jsonBody({ username, password: TEST_PASSWORD }));
    expect(res.status).toBe(200);
    return sessionFrom(res);
};
const me = async (cookie: string) =>
    Me.parse(await (await s.app.request('/api/v1/auth/me', { headers: { cookie } })).json());

describe('accounts', () => {
    it('setup 建的第一个账户是管理员;成员登录后 /auth/me 返回 member', async () => {
        const setup = await s.app.request(
            '/api/v1/auth/setup',
            jsonBody({ username: 'owner', password: TEST_PASSWORD }),
        );
        expect(await me(sessionFrom(setup).cookie)).toMatchObject({
            username: 'owner',
            role: 'admin',
            displayName: null,
        });

        // 建成员的接口在下一个 PR;这里直接写库
        s.repos.owners.create({
            username: 'kid',
            passwordHash: await hashPassword(TEST_PASSWORD),
            displayName: '小明',
        });
        const { cookie } = await login('kid');
        expect(await me(cookie)).toMatchObject({ username: 'kid', role: 'member', displayName: '小明' });
    });

    it('两个 setup 同时到达:只有一个成功,另一个 409 already_initialized,只有一个账户', async () => {
        const [a, b] = await Promise.all(
            ['first', 'second'].map((username) =>
                s.app.request('/api/v1/auth/setup', jsonBody({ username, password: TEST_PASSWORD })),
            ),
        );
        expect([a!.status, b!.status].sort()).toEqual([201, 409]);
        const conflict = a!.status === 409 ? a! : b!;
        expect(await conflict.json()).toMatchObject({ code: 'already_initialized' });
        expect(s.repos.owners.count()).toBe(1);
        expect(s.repos.owners.get(s.repos.owners.ids()[0]!)?.role).toBe('admin');
    });

    it('requireAdmin:管理员放行,成员与停用的管理员回 403 admin_required,未登录回 401', async () => {
        const admin = s.repos.owners.create({ username: 'a', passwordHash: 'x' }).id;
        const member = s.repos.owners.create({ username: 'm', passwordHash: 'x' }).id;
        const second = s.repos.owners.create({ username: 'b', passwordHash: 'x', role: 'admin' }).id;
        s.conn.sqlite.prepare("UPDATE owners SET disabled_at = '2026-11-25T00:00:00.000Z' WHERE id = ?").run(second);

        const app = new Hono<AppEnv>();
        app.onError((error, c) =>
            error instanceof ApiError ? c.json({ code: error.code }, error.status as 401 | 403) : c.text('x', 500),
        );
        app.get('/probe/:as', (c) => {
            const as = c.req.param('as');
            if (as !== 'nobody') c.set('auth', { ownerId: as } as AppEnv['Variables']['auth']);
            else c.set('auth', null);
            return c.json({ ownerId: requireAdmin(c, s.repos) });
        });
        const call = async (as: string) => {
            const res = await app.request(`/probe/${as}`);
            return `${res.status} ${JSON.stringify(await res.json())}`;
        };
        expect(await call(admin)).toBe(`200 {"ownerId":"${admin}"}`);
        expect(await call(member)).toBe('403 {"code":"admin_required"}');
        expect(await call(second)).toBe('403 {"code":"admin_required"}');
        expect(await call('nobody')).toBe('401 {"code":"unauthorized"}');
        // 降级立即生效:角色每次从库里读
        s.conn.sqlite.prepare('UPDATE owners SET disabled_at = NULL WHERE id = ?').run(second);
        s.conn.sqlite.prepare("UPDATE owners SET role = 'member' WHERE id = ?").run(admin);
        expect(await call(admin)).toBe('403 {"code":"admin_required"}');
    });
});
