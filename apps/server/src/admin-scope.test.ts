// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 管理员路由扫描(ADR 0053 第 6 节):OpenAPI 里标了 `x-fatcat-admin: true` 的每条路由,用成员的会话逐条调用,
// 全部 403 admin_required,数据库里账户相关和安装级能力(第 4 节)的表一行不变。/admin/ 下的路由必须都标了;
// /admin/ 以外标了的是第 4 节「只有管理员能开」的能力(文件夹、MCP、插件、嵌入、密钥文件)。
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
    'POST /api/v1/admin/users/{id}/fs-roots': { path: '/tmp' },
    'POST /api/v1/fs/roots': { path: '/tmp' },
    'POST /api/v1/mcp/servers': { name: 'x', command: 'node', args: [] },
    'PATCH /api/v1/mcp/servers/{id}': { enabled: false },
    'POST /api/v1/settings/secrets/migrate': { confirm: true, plaintextBackups: 'keep' },
    'POST /api/v1/plugins/prepare': { source: { kind: 'local', path: '/tmp' } },
    'POST /api/v1/plugins/install': { stagingId: '0123456789abcdef', accept: true },
    'PATCH /api/v1/plugins/{id}': { enabled: false },
};
const TABLES = [
    'owners',
    'account_codes',
    'auth_sessions',
    'access_tokens',
    'devices',
    'sessions',
    'fs_roots',
    'mcp_servers',
    'plugins',
];

let server: TestServer | undefined;
afterEach(async () => {
    await server?.cleanup();
    server = undefined;
});

describe('管理员路由(ADR 0053 第 6 节)', () => {
    it('/admin/ 下的路由都标了 x-fatcat-admin;第 4 节的安装级能力也标了', () => {
        const all = routes();
        expect(all.filter((r) => r.path.startsWith('/api/v1/admin/') && !r.admin)).toEqual([]);
        const marked = new Set(all.filter((r) => r.admin).map((r) => `${r.method} ${r.path}`));
        for (const key of [
            'POST /api/v1/fs/roots',
            'DELETE /api/v1/fs/roots/{id}',
            'POST /api/v1/admin/users/{id}/fs-roots',
            'POST /api/v1/mcp/servers',
            'PATCH /api/v1/mcp/servers/{id}',
            'POST /api/v1/plugins/prepare',
            'POST /api/v1/plugins/install',
            'PATCH /api/v1/plugins/{id}',
            'POST /api/v1/embeddings/rebuild',
            'POST /api/v1/settings/secrets/migrate',
        ]) {
            expect(marked.has(key), key).toBe(true);
        }
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
            // 插件 id 有自己的格式;其余路径参数都用管理员的账户 id(成员拿到的是别人的 id)
            const param = route.path.startsWith('/api/v1/plugins/') ? 'demo' : ownerId;
            const res = await s.app.request(route.path.replace(/\{\w+\}/g, param), {
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
