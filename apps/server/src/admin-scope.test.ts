// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 管理员路由扫描(ADR 0053 第 6 节):OpenAPI 里标了 `x-fatcat-admin: true` 的每条路由,用成员的会话逐条调用,
// 全部 403 admin_required,数据库里账户相关的表一行不变。/admin/ 下的路由必须都标了。
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const openapi = JSON.parse(readFileSync(new URL('../openapi/v1.json', import.meta.url), 'utf8')) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function routes(): { method: string; path: string; admin: boolean }[] {
    return Object.entries(openapi.paths).flatMap(([path, ops]) =>
        Object.entries(ops)
            .filter(([method]) => METHODS.includes(method))
            .map(([method, op]) => ({ method: method.toUpperCase(), path, admin: op['x-fatcat-admin'] === true })),
    );
}

/** 成员调用时手写的最小请求体:能过校验,确保 403 来自角色检查而不是 400。 */
const BODIES: Record<string, unknown> = {
    'PATCH /api/v1/admin/users/{id}': { disabled: true },
    'DELETE /api/v1/admin/users/{id}': { confirmUsername: 'owner' },
};
const TABLES = ['owners', 'account_codes', 'auth_sessions', 'access_tokens', 'devices', 'sessions'];

let server: TestServer | undefined;
afterEach(async () => {
    await server?.cleanup();
    server = undefined;
});

describe('管理员路由(ADR 0053 第 6 节)', () => {
    it('/admin/ 下的路由都标了 x-fatcat-admin,标了的都在 /admin/ 下', () => {
        const all = routes();
        expect(all.filter((r) => r.path.startsWith('/api/v1/admin/') !== r.admin)).toEqual([]);
        expect(all.filter((r) => r.admin).length).toBeGreaterThanOrEqual(5);
    });

    it('成员调用每条管理员路由都是 403 admin_required,数据不变', async () => {
        const s = await createTestServer();
        server = s;
        const admin = sessionFrom(
            await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD })),
        );
        const headers = (who: { cookie: string; csrf: string }) => ({
            cookie: who.cookie,
            'X-CSRF-Token': who.csrf,
            'content-type': 'application/json',
        });
        const invite = (await (
            await s.app.request('/api/v1/admin/users/invites', { method: 'POST', headers: headers(admin) })
        ).json()) as { code: string };
        const member = sessionFrom(
            await s.app.request(
                '/api/v1/auth/invite/accept',
                jsonBody({ code: invite.code, username: 'kid', password: TEST_PASSWORD }),
            ),
        );
        const ownerId = s.repos.owners.primaryAdmin()!;
        const snapshot = () =>
            TABLES.map((t) => JSON.stringify(s.conn.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).join(
                '\n',
            );
        const before = snapshot();
        const answers: string[] = [];
        for (const route of routes().filter((r) => r.admin)) {
            const key = `${route.method} ${route.path}`;
            const body = BODIES[key];
            const res = await s.app.request(route.path.replace('{id}', ownerId), {
                method: route.method,
                headers: headers(member),
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const json = (await res.json()) as { code?: string };
            if (res.status !== 403 || json.code !== 'admin_required')
                answers.push(`${key}: ${res.status} ${json.code}`);
        }
        expect(answers).toEqual([]);
        expect(snapshot()).toBe(before);
    });
});
