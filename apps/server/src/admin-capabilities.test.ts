// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 安装级能力只有管理员能开(ADR 0053 第 4 节):授权文件夹由管理员添加并可以分配给成员,成员只能用分给自己的;
// 编码项目、embed 配置档、MCP 只有管理员能配置;嵌入模型整个安装共用;降为成员后运行时也拦住。
// 每条「只有管理员」的路由用成员调用回 403 的扫描在 admin-scope.test.ts。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsRoot, LoginResponse, McpServerInput } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
type Session = { cookie: string; csrf: string };
let admin: Session;
let folder: string;

beforeEach(async () => {
    s = await createTestServer();
    admin = sessionFrom(
        await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD })),
    );
    folder = mkdtempSync(join(tmpdir(), 'fatcat-assign-'));
});
afterEach(async () => {
    await s.cleanup();
    rmSync(folder, { recursive: true, force: true });
});

const as = (who: Session, method: string, path: string, body?: unknown) =>
    s.app.request(path, {
        method,
        headers: { cookie: who.cookie, 'X-CSRF-Token': who.csrf, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
};
const member = async (username = 'kid') => {
    const { code } = await json<{ code: string }>(await as(admin, 'POST', '/api/v1/admin/users/invites'), 201);
    const res = await s.app.request(
        '/api/v1/auth/invite/accept',
        jsonBody({ code, username, password: TEST_PASSWORD }),
    );
    expect(res.status).toBe(201);
    return { id: LoginResponse.parse(await res.json()).owner.id, session: sessionFrom(res) as Session };
};
const roots = async (who: Session) =>
    (await json<{ items: FsRoot[] }>(await as(who, 'GET', '/api/v1/fs/roots'), 200)).items;

describe('admin capabilities (ADR 0053 section 4)', () => {
    it('文件夹:只有管理员能添加;分配给成员后成员看得到、能选知识库,但不能删、不能自己加;收回后就看不到', async () => {
        const kid = await member();
        const denied = await json<{ code: string }>(
            await as(kid.session, 'POST', '/api/v1/fs/roots', { path: folder }),
            403,
        );
        expect(denied.code).toBe('admin_required');

        // 管理员自己用和分给成员是两行;分给成员的不出现在管理员自己的列表里
        const own = await json<FsRoot>(await as(admin, 'POST', '/api/v1/fs/roots', { path: folder }), 201);
        const assigned = await json<FsRoot>(
            await as(admin, 'POST', `/api/v1/admin/users/${kid.id}/fs-roots`, { path: folder, label: 'Homework' }),
            201,
        );
        expect(assigned.id).not.toBe(own.id);
        expect((await roots(admin)).map((r) => r.id)).toEqual([own.id]);
        expect((await roots(kid.session)).map((r) => [r.id, r.label])).toEqual([[assigned.id, 'Homework']]);
        const listed = await json<{ items: FsRoot[] }>(
            await as(admin, 'GET', `/api/v1/admin/users/${kid.id}/fs-roots`),
            200,
        );
        expect(listed.items.map((r) => r.id)).toEqual([assigned.id]);
        // 同一个账户重复分配同一个文件夹:409
        expect((await as(admin, 'POST', `/api/v1/admin/users/${kid.id}/fs-roots`, { path: folder })).status).toBe(409);

        // 成员能决定分给自己的文件夹进不进知识库,但不能删,也碰不到管理员的那一行
        const kb = await json<FsRoot>(
            await as(kid.session, 'PATCH', `/api/v1/fs/roots/${assigned.id}`, { knowledgeBase: true }),
            200,
        );
        expect(kb.knowledgeBase).toBe(true);
        expect((await as(kid.session, 'DELETE', `/api/v1/fs/roots/${assigned.id}`)).status).toBe(403);
        expect((await as(kid.session, 'PATCH', `/api/v1/fs/roots/${own.id}`, { knowledgeBase: true })).status).toBe(
            404,
        );

        // 管理员只能从 /admin 的路由收回;用自己的 DELETE 删不到成员那一行
        expect((await as(admin, 'DELETE', `/api/v1/fs/roots/${assigned.id}`)).status).toBe(404);
        expect((await as(admin, 'DELETE', `/api/v1/admin/users/${kid.id}/fs-roots/${assigned.id}`)).status).toBe(204);
        expect(await roots(kid.session)).toEqual([]);
        expect((await roots(admin)).map((r) => r.id)).toEqual([own.id]);
        // 不存在的账户
        expect((await as(admin, 'GET', `/api/v1/admin/users/${own.id}/fs-roots`)).status).toBe(404);
    });

    it('编码项目只有管理员能配置;成员改别的设置照常;降为成员后编码工具不能用', async () => {
        const kid = await member();
        const code = await json<{ code: string }>(
            await as(kid.session, 'PUT', '/api/v1/settings', { code: { enabled: true } }),
            403,
        );
        expect(code.code).toBe('admin_required');
        expect(s.repos.settings.get(kid.id).code?.enabled).toBe(false);
        expect((await as(kid.session, 'PUT', '/api/v1/settings', { theme: 'cat' })).status).toBe(200);

        // 设置里开着(例如以前是管理员),但现在是成员:编码工具拒绝
        s.repos.settings.update(kid.id, { code: { enabled: true, projects: [] } });
        const gitLog = s.runs.tools!.get('git.log')!;
        await expect(gitLog.execute({ project: 'x' }, { ownerId: kid.id } as never)).rejects.toThrow(/turned off/);
        s.repos.settings.update(s.repos.owners.primaryAdmin()!, { code: { enabled: true, projects: [] } });
        // 管理员:过了开关检查,停在「没有这个项目」
        await expect(
            gitLog.execute({ project: 'x' }, { ownerId: s.repos.owners.primaryAdmin()! } as never),
        ).rejects.toThrow(/project/i);
    });

    it('嵌入模型:只有管理员能建 embed 配置档;所有账户共用主管理员的,成员只看到模型名', async () => {
        const kid = await member();
        const profile = (purpose: string[]) => ({
            label: 'p',
            kind: 'openai-compatible',
            baseURL: 'https://embed.example.test/v1',
            apiKeyRef: 'env:KEY',
            model: 'text-embed',
            purpose,
        });
        const denied = await json<{ code: string }>(
            await as(kid.session, 'POST', '/api/v1/models', profile(['embed'])),
            403,
        );
        expect(denied.code).toBe('admin_required');
        const chat = await json<{ id: string }>(
            await as(kid.session, 'POST', '/api/v1/models', profile(['chat'])),
            201,
        );
        // 改成 embed 也不行
        expect((await as(kid.session, 'PATCH', `/api/v1/models/${chat.id}`, { purpose: ['embed'] })).status).toBe(403);

        const embed = await json<{ id: string }>(await as(admin, 'POST', '/api/v1/models', profile(['embed'])), 201);
        const mine = await json<{ profileId: string | null; model: string | null }>(
            await as(admin, 'GET', '/api/v1/embeddings/status'),
            200,
        );
        expect(mine).toMatchObject({ profileId: embed.id, model: 'text-embed' });
        const theirs = await json<{ profileId: string | null; model: string | null; state: string }>(
            await as(kid.session, 'GET', '/api/v1/embeddings/status'),
            200,
        );
        expect(theirs).toMatchObject({ profileId: null, model: 'text-embed', state: 'ready' });
        expect((await as(kid.session, 'POST', '/api/v1/embeddings/rebuild')).status).toBe(403);
    });

    it('MCP 只为管理员运行:降为成员后它的服务器不再启动,升回管理员才启动', () => {
        const ownerId = s.repos.owners.primaryAdmin()!;
        s.repos.mcpServers.create(ownerId, McpServerInput.parse({ name: 'tool', command: 'node' }));
        expect(s.repos.mcpServers.allEnabled().map((m) => m.name)).toEqual(['tool']);
        const second = s.repos.owners.create({ username: 'second', passwordHash: 'x', role: 'admin' });
        expect(s.repos.accounts.setRole(ownerId, 'member')).toBe('ok');
        expect(s.repos.mcpServers.allEnabled()).toEqual([]);
        expect(s.repos.accounts.setRole(ownerId, 'admin')).toBe('ok');
        expect(s.repos.mcpServers.allEnabled().map((m) => m.name)).toEqual(['tool']);
        expect(second.role).toBe('admin');
    });
});
