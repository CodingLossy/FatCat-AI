// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// MCP 服务器配置 REST(ADR 0013):只有登录且带 CSRF 的用户能配置;工具默认需审批;删除时预授权一并删除并审计。
import { fileURLToPath } from 'node:url';
import { AuditEntry, McpServerView, pageOf, ToolInfo } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const FAKE = fileURLToPath(new URL('../../../packages/tools/test/fake-mcp-server.mjs', import.meta.url));
const config = { name: 'fake', command: process.execPath, args: [FAKE] };

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

async function setup() {
    s = await createTestServer();
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const req = (p: string, init: RequestInit = {}) => s.app.request(p, { ...init, headers });
    const send = (method: string, p: string, body?: unknown) =>
        req(p, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const list = async () => pageOf(McpServerView).parse(await (await req('/api/v1/mcp/servers')).json()).items;
    /** 连接在后台进行:等到状态不再是 connecting。 */
    const settled = async () => {
        for (let i = 0; i < 100; i++) {
            const items = await list();
            if (items.every((x) => x.status.state !== 'connecting')) return items;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error('MCP server did not settle');
    };
    return { cookie, send, req, list, settled };
}

describe('MCP 服务器 REST', () => {
    it('越权:未登录或缺少 CSRF 时不能配置服务器', async () => {
        const { cookie, list } = await setup();
        const noLogin = await s.app.request('/api/v1/mcp/servers', jsonBody(config));
        expect(noLogin.status).toBe(401);
        const noCsrf = await s.app.request('/api/v1/mcp/servers', jsonBody(config, { cookie }));
        expect(noCsrf.status).toBe(403);
        expect(await list()).toEqual([]);
    });

    it('拒绝不合法的名字、相对 cwd 与本项目的环境变量(FATCAT_AI_* 与旧名 AIP_*)', async () => {
        const { send } = await setup();
        expect((await send('POST', '/api/v1/mcp/servers', { ...config, name: 'Bad Name' })).status).toBe(400);
        expect((await send('POST', '/api/v1/mcp/servers', { ...config, cwd: 'relative/dir' })).status).toBe(400);
        const env = await send('POST', '/api/v1/mcp/servers', { ...config, envPassthrough: ['FATCAT_AI_DATA_DIR'] });
        expect(env.status).toBe(400);
        const legacy = await send('POST', '/api/v1/mcp/servers', { ...config, envPassthrough: ['AIP_DATA_DIR'] });
        expect(legacy.status).toBe(400);
    });

    it('新增后注册 mcp.<server>.<tool>(默认需审批);重名 409;停用后工具移除;删除时预授权一并删除并审计', async () => {
        const { send, req, settled } = await setup();
        const created = await send('POST', '/api/v1/mcp/servers', { ...config, toolRisks: { echo: 'read' } });
        expect(created.status).toBe(201);
        const server = McpServerView.parse(await created.json());
        const [ready] = await settled();
        expect(ready?.status).toMatchObject({ state: 'connected', error: null });
        expect(ready?.status.tools).toContain('mcp.fake.echo');

        const tools = ToolInfo.array().parse(
            ((await (await req('/api/v1/tools')).json()) as { items: unknown[] }).items,
        );
        const byName = new Map(tools.map((t) => [t.name, t]));
        expect(byName.get('mcp.fake.echo')).toMatchObject({ risk: 'read', approval: 'auto', source: 'mcp' });
        expect(byName.get('mcp.fake.fail')).toMatchObject({ risk: 'write', approval: 'required', server: 'fake' });

        expect((await send('POST', '/api/v1/mcp/servers', config)).status).toBe(409);

        const disabled = await send('PATCH', `/api/v1/mcp/servers/${server.id}`, { enabled: false });
        expect(McpServerView.parse(await disabled.json())).toMatchObject({ enabled: false });
        expect((await settled())[0]?.status).toMatchObject({ state: 'disabled', tools: [] });
        const after = (await (await req('/api/v1/tools')).json()) as { items: { name: string }[] };
        expect(after.items.some((t) => t.name.startsWith('mcp.'))).toBe(false);

        const ownerId = s.repos.owners.getByUsername('owner')!.id;
        s.repos.preauths.create(ownerId, {
            toolName: 'mcp.fake.fail',
            scope: 'always',
            sessionId: null,
            constraint: null,
        });
        expect((await send('DELETE', `/api/v1/mcp/servers/${server.id}`)).status).toBe(204);
        expect(s.repos.preauths.list(ownerId)).toEqual([]);
        const audit = pageOf(AuditEntry).parse(await (await req('/api/v1/audit')).json());
        expect(audit.items[0]).toMatchObject({ action: 'preauth-revoked', toolName: 'mcp.fake.fail' });
        expect((await send('DELETE', `/api/v1/mcp/servers/${server.id}`)).status).toBe(404);
    });
});
