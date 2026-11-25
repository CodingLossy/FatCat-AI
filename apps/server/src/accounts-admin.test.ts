// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 账户管理(ADR 0053 第 2、6 节):邀请码建成员、重置码改密码、停用 / 启用、改角色、删除(先备份、删 secrets 行),
// 只有管理员的浏览器会话能管;登录失败按用户名和来源地址分别限速。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, AccountList, CreatedAccountCode, LoginResponse } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
type Session = { cookie: string; csrf: string };
let admin: Session;

const NEW_PASSWORD = 'another long password 42';

beforeEach(async () => {
    s = await createTestServer();
    admin = sessionFrom(
        await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD })),
    );
});
afterEach(async () => {
    await s.cleanup();
});

const as = (who: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    s.app.request(path, {
        method,
        headers: { cookie: who.cookie, 'X-CSRF-Token': who.csrf, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
const invite = async () => {
    const res = await as(admin, 'POST', '/api/v1/admin/users/invites');
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    return CreatedAccountCode.parse(await res.json());
};
const accept = (code: string, username: string, ip = '10.0.0.1') =>
    s.app.request(
        '/api/v1/auth/invite/accept',
        jsonBody({ code, username, password: TEST_PASSWORD }, { 'x-test-ip': ip }),
    );
const login = (username: string, password = TEST_PASSWORD, ip = '10.0.0.2') =>
    s.app.request('/api/v1/auth/login', jsonBody({ username, password }, { 'x-test-ip': ip }));
const join2 = async (username = 'kid') => {
    const { code } = await invite();
    const res = await accept(code, username);
    expect(res.status).toBe(201);
    const body = LoginResponse.parse(await res.json());
    return { id: body.owner.id, session: sessionFrom(res) as Session };
};
const me = async (who: Session) => (await as(who, 'GET', '/api/v1/auth/me')).status;

describe('account administration', () => {
    it('邀请码:对方设自己的用户名密码成为成员并登录;用户名被占用时码不作废;码只能用一次', async () => {
        const { code, expiresAt } = await invite();
        expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
        const taken = await accept(code, 'owner');
        expect(taken.status).toBe(409);
        const ok = await accept(code.toLowerCase(), 'kid');
        expect(ok.status).toBe(201);
        const kid = sessionFrom(ok);
        expect(await (await as(kid, 'GET', '/api/v1/auth/me')).json()).toMatchObject({
            username: 'kid',
            role: 'member',
        });
        expect((await accept(code, 'kid2')).status).toBe(401);
        expect((await accept('AAAAA-BBBBB', 'kid3')).status).toBe(401);

        const list = AccountList.parse(await (await as(admin, 'GET', '/api/v1/admin/users')).json());
        expect(list.accounts.map((a) => [a.username, a.role, a.disabled])).toEqual([
            ['owner', 'admin', false],
            ['kid', 'member', false],
        ]);
        expect(JSON.stringify(list)).not.toContain('password');
        expect(s.logs.join('')).not.toContain(code);
    });

    it('停用:成员的会话立即失效、登录和密码错误回答一样;启用后能重新登录;自己不能停用自己', async () => {
        const kid = await join2();
        expect(await me(kid.session)).toBe(200);
        const res = await as(admin, 'PATCH', `/api/v1/admin/users/${kid.id}`, { disabled: true });
        expect(res.status).toBe(200);
        expect(Account.parse(await res.json()).disabled).toBe(true);
        expect(await me(kid.session)).toBe(401);
        const denied = await login('kid');
        const wrong = await login('kid', 'wrong password 12345', '10.0.0.3');
        expect([denied.status, wrong.status]).toEqual([401, 401]);
        const shape = async (r: Response) => {
            const { code, title, detail } = (await r.json()) as Record<string, unknown>;
            return { code, title, detail };
        };
        expect(await shape(denied)).toEqual(await shape(wrong));

        expect((await as(admin, 'PATCH', `/api/v1/admin/users/${kid.id}`, { disabled: false })).status).toBe(200);
        expect(await me(kid.session)).toBe(401); // 旧会话不恢复
        expect((await login('kid', TEST_PASSWORD, '10.0.0.4')).status).toBe(200);

        const ownerId = s.repos.owners.primaryAdmin()!;
        expect((await as(admin, 'PATCH', `/api/v1/admin/users/${ownerId}`, { disabled: true })).status).toBe(409);
        expect((await as(admin, 'PATCH', `/api/v1/admin/users/${ownerId}`, { role: 'member' })).status).toBe(409);
        expect((await as(admin, 'PATCH', `/api/v1/admin/users/${ownerId}`, { displayName: '管理员' })).status).toBe(
            200,
        );
    });

    it('重置码:成员设新密码,旧会话失效、旧密码不能用;码只能用一次', async () => {
        const kid = await join2();
        const res = await as(admin, 'POST', `/api/v1/admin/users/${kid.id}/reset-code`);
        expect(res.status).toBe(201);
        const { code, kind } = CreatedAccountCode.parse(await res.json());
        expect(kind).toBe('reset');
        const reset = () => s.app.request('/api/v1/auth/password/reset', jsonBody({ code, password: NEW_PASSWORD }));
        expect((await reset()).status).toBe(204);
        expect(await me(kid.session)).toBe(401);
        expect((await login('kid')).status).toBe(401);
        expect((await login('kid', NEW_PASSWORD, '10.0.0.9')).status).toBe(200);
        expect((await reset()).status).toBe(401);
        const ownerId = s.repos.owners.primaryAdmin()!;
        expect((await as(admin, 'POST', `/api/v1/admin/users/${ownerId}/reset-code`)).status).toBe(409);
    });

    it('改角色:成员升为管理员后能管账户;最后一个管理员不能被降级', async () => {
        const kid = await join2();
        expect((await as(kid.session, 'GET', '/api/v1/admin/users')).status).toBe(403);
        expect((await as(admin, 'PATCH', `/api/v1/admin/users/${kid.id}`, { role: 'admin' })).status).toBe(200);
        expect((await as(kid.session, 'GET', '/api/v1/admin/users')).status).toBe(200);
        const ownerId = s.repos.owners.primaryAdmin()!;
        expect((await as(kid.session, 'PATCH', `/api/v1/admin/users/${ownerId}`, { role: 'member' })).status).toBe(200);
        // 现在 kid 是唯一的管理员:owner 不能再动 kid,kid 也不能降自己
        expect((await as(admin, 'GET', '/api/v1/admin/users')).status).toBe(403);
        expect((await as(kid.session, 'PATCH', `/api/v1/admin/users/${kid.id}`, { role: 'member' })).status).toBe(409);
    });

    it('删除:要输入用户名确认;先备份数据库,删掉账户的数据和 secrets.yaml 里它的行,其他行不变', async () => {
        const kid = await join2();
        const session = s.repos.sessions.create(kid.id, { title: 'mine' });
        const secretsFile = join(s.dir, 'secrets.yaml');
        writeFileSync(secretsFile, `OTHER_KEY: keep-me\nU${kid.id}_OPENAI_API_KEY: sk-kid\n`, { mode: 0o600 });

        const wrong = await as(admin, 'DELETE', `/api/v1/admin/users/${kid.id}`, { confirmUsername: 'owner' });
        expect(wrong.status).toBe(400);
        const ownerId = s.repos.owners.primaryAdmin()!;
        expect((await as(admin, 'DELETE', `/api/v1/admin/users/${ownerId}`, { confirmUsername: 'owner' })).status).toBe(
            409,
        );
        const res = await as(admin, 'DELETE', `/api/v1/admin/users/${kid.id}`, { confirmUsername: 'kid' });
        expect(res.status).toBe(204);
        expect(readdirSync(join(s.dir, 'backups')).some((f) => /^db-.*-pre-delete-account\.sqlite$/.test(f))).toBe(
            true,
        );
        expect(s.repos.sessions.get(kid.id, session.id)).toBeNull();
        expect(s.repos.owners.get(kid.id)).toBeNull();
        expect(await me(kid.session)).toBe(401);
        expect(readFileSync(secretsFile, 'utf8')).toBe('OTHER_KEY: keep-me\n');
        expect(existsSync(join(s.dir, 'backups'))).toBe(true);
        expect(s.conn.sqlite.pragma('foreign_key_check')).toEqual([]);
        expect((await as(admin, 'DELETE', `/api/v1/admin/users/${kid.id}`, { confirmUsername: 'kid' })).status).toBe(
            404,
        );
    });

    it('账户管理只接受浏览器会话:管理员的个人访问令牌回 403 forbidden', async () => {
        const created = await as(admin, 'POST', '/api/v1/tokens', { name: 'cli' });
        expect(created.status).toBe(201);
        const { token } = (await created.json()) as { token: string };
        const res = await s.app.request('/api/v1/admin/users', { headers: { authorization: `Bearer ${token}` } });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'forbidden' });
    });

    it('登录失败按用户名累计:换来源地址也会被锁', async () => {
        for (let i = 0; i < 5; i++) {
            expect((await login('owner', 'wrong password 12345', `10.1.0.${i}`)).status).toBe(401);
        }
        expect((await login('owner', TEST_PASSWORD, '10.2.0.1')).status).toBe(429);
        expect((await login('nobody', 'wrong password 12345', '10.2.0.1')).status).toBe(401);
    });
});
