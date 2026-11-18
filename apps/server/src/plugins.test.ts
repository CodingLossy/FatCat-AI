// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件管理 REST 与卸载(ADR 0040 PR 2b):只有登录且带 CSRF 的主人能安装;卸载快照一致;预授权、任务与审批的善后。
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginDetail, PluginPrepared, PluginView, pageOf, ToolInfo } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { protectionTable } from './plugin-setup.js';
import { PLUGIN_ITEM_QUOTA, upsertPluginItems } from './plugin-items.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const fixtures = fileURLToPath(new URL('../../../packages/tools/src/plugins/fixtures/', import.meta.url));

let s: TestServer;
const cleanups: string[] = [];
afterEach(async () => {
    await s?.cleanup();
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sourceDir(patch: (manifest: Record<string, unknown>) => void = () => undefined): string {
    const dir = mkdtempSync(join(tmpdir(), 'fatcat-plugin-src-'));
    cleanups.push(dir);
    cpSync(fixtures, dir, { recursive: true, filter: (p) => !p.endsWith('.test.ts') });
    const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as Record<string, unknown>;
    patch(manifest);
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
    return dir;
}

async function setup() {
    s = await createTestServer();
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const send = (method: string, p: string, body?: unknown) =>
        s.app.request(p, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const list = async () => pageOf(PluginView).parse(await (await send('GET', '/api/v1/plugins')).json()).items;
    const settled = async () => {
        for (let i = 0; i < 200; i++) {
            const items = await list();
            if (items.every((x) => x.state !== 'enabled' || x.run.state === 'running' || x.run.state === 'idle'))
                return items;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error('plugin did not settle');
    };
    const install = async (path: string) => {
        const prepared = PluginPrepared.parse(
            await (await send('POST', '/api/v1/plugins/prepare', { source: { kind: 'local', path } })).json(),
        );
        const res = await send('POST', '/api/v1/plugins/install', { stagingId: prepared.stagingId, accept: true });
        return { prepared, res };
    };
    return { cookie, send, list, settled, install };
}

/** 路径与大小的快照(第 6.1 节「卸载验收」);只看插件目录,数据库文件本身随写入变化。 */
function tree(root: string): Record<string, number> {
    const out: Record<string, number> = {};
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            const stat = statSync(full);
            if (stat.isDirectory()) {
                out[`${full.slice(root.length)}/`] = 0;
                walk(full);
            } else out[full.slice(root.length)] = stat.size;
        }
    };
    for (const sub of ['plugins', 'plugin-data']) {
        try {
            walk(join(root, sub));
        } catch {
            // 还不存在
        }
    }
    return out;
}

function rowCounts(): Record<string, number> {
    const tables = s.conn.sqlite
        .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((r) => r.name)
        .filter((n) => !['plugin_events', 'audit_log'].includes(n) && !n.includes('_fts'));
    return Object.fromEntries(
        tables.map((name) => [
            name,
            s.conn.sqlite.prepare<[], { n: number }>(`SELECT count(*) AS n FROM "${name}"`).get()!.n,
        ]),
    );
}

describe('插件 REST', () => {
    it('越权:未登录或缺少 CSRF 时不能准备、安装或卸载', async () => {
        const { cookie } = await setup();
        const src = sourceDir();
        const body = { source: { kind: 'local', path: src } };
        expect((await s.app.request('/api/v1/plugins/prepare', jsonBody(body))).status).toBe(401);
        expect((await s.app.request('/api/v1/plugins/prepare', jsonBody(body, { cookie }))).status).toBe(403);
        expect((await s.app.request('/api/v1/plugins', { method: 'GET' })).status).toBe(401);
    });

    it('拒绝不合格的包:符号链接、相对路径、缺清单;拒绝不同意全部权限', async () => {
        const { send, install } = await setup();
        const withLink = sourceDir();
        const { symlinkSync } = await import('node:fs');
        symlinkSync('/etc/hostname', join(withLink, 'link.txt'));
        expect(
            (await send('POST', '/api/v1/plugins/prepare', { source: { kind: 'local', path: withLink } })).status,
        ).toBe(400);
        expect(
            (await send('POST', '/api/v1/plugins/prepare', { source: { kind: 'local', path: 'relative/dir' } })).status,
        ).toBe(400);
        const empty = mkdtempSync(join(tmpdir(), 'fatcat-plugin-empty-'));
        cleanups.push(empty);
        expect((await send('POST', '/api/v1/plugins/prepare', { source: { kind: 'local', path: empty } })).status).toBe(
            400,
        );
        const { prepared } = await install(sourceDir());
        expect(
            (await send('POST', '/api/v1/plugins/install', { stagingId: prepared.stagingId, accept: false })).status,
        ).toBe(400);
    });

    it('安装后注册 plugin.<id>.<tool>(来源 plugin);同名再装 409;停用后工具移除', async () => {
        const { send, settled, install } = await setup();
        const { prepared, res } = await install(sourceDir());
        expect(prepared.unreviewed).toBe(true);
        expect(prepared.protections.map((p) => p.key)).toContain('direct-network');
        expect(res.status).toBe(201);
        const [ready] = await settled();
        expect(ready).toMatchObject({ id: 'probe', state: 'enabled', unreviewed: true });
        expect(ready?.run.tools.sort()).toEqual(['plugin.probe.echo', 'plugin.probe.probe']);

        const tools = ToolInfo.array().parse(
            ((await (await send('GET', '/api/v1/tools')).json()) as { items: unknown[] }).items,
        );
        expect(tools.find((t) => t.name === 'plugin.probe.echo')).toMatchObject({
            source: 'plugin',
            server: 'probe',
            approval: 'auto',
        });

        expect((await install(sourceDir())).res.status).toBe(409);

        const off = await send('PATCH', '/api/v1/plugins/probe', { enabled: false });
        expect(PluginView.parse(await off.json())).toMatchObject({ state: 'disabled' });
        const after = ToolInfo.array().parse(
            ((await (await send('GET', '/api/v1/tools')).json()) as { items: unknown[] }).items,
        );
        expect(after.some((t) => t.name.startsWith('plugin.probe.'))).toBe(false);
    }, 60_000);

    it('必需的密钥没绑定时安装后是停用的,启用返回 409;只接受 env: 引用', async () => {
        const { send, install } = await setup();
        const src = sourceDir((m) => {
            (m.permissions as { secrets: { required?: boolean }[] }).secrets[0]!.required = true;
        });
        expect((await install(src)).res.status).toBe(201);
        const detail = PluginDetail.parse(await (await send('GET', '/api/v1/plugins/probe')).json());
        expect(detail).toMatchObject({ state: 'disabled', missingSecrets: ['WEATHER_API_KEY'] });
        expect((await send('PATCH', '/api/v1/plugins/probe', { enabled: true })).status).toBe(409);
        expect(
            (await send('PATCH', '/api/v1/plugins/probe', { secretRefs: { WEATHER_API_KEY: 'plain-text-value' } }))
                .status,
        ).toBe(400);
        expect((await send('PATCH', '/api/v1/plugins/probe', { secretRefs: { UNDECLARED: 'env:X' } })).status).toBe(
            400,
        );
    }, 60_000);

    it('设置按清单的 settings 声明校验;详情带 settingsSchema 与保护程度表', async () => {
        const { send, install, settled } = await setup();
        const src = sourceDir((m) => {
            m.settings = {
                type: 'object',
                properties: {
                    city: { type: 'string', maxLength: 8 },
                    days: { type: 'number', minimum: 1, maximum: 7 },
                },
                required: ['city'],
            };
        });
        expect((await install(src)).res.status).toBe(201);
        await settled();
        const bad = await send('PATCH', '/api/v1/plugins/probe', { settings: { city: 'Beijing-Haidian', other: 1 } });
        expect(bad.status).toBe(400);
        expect(JSON.stringify(await bad.json())).toContain('other: not declared by the plugin');
        const good = await send('PATCH', '/api/v1/plugins/probe', { settings: { city: 'Paris', days: 3 } });
        expect(good.status).toBe(200);
        expect(PluginView.parse(await good.json()).settings).toEqual({ city: 'Paris', days: 3 });
        const detail = PluginDetail.parse(await (await send('GET', '/api/v1/plugins/probe')).json());
        expect(detail.settingsSchema?.required).toEqual(['city']);
        expect(detail.protections.find((r) => r.key === 'direct-network')?.level).toBe('layered');
    });

    it('插件条目出现在知识地图、能打开,卸载后消失;推送的条目按配额拒绝', async () => {
        const { send, install, settled } = await setup();
        const src = sourceDir((m) => {
            (m.permissions as Record<string, unknown>).items = {
                categories: [{ type: 'video', title: { en: 'Videos', 'zh-CN': '视频' } }],
            };
        });
        expect((await install(src)).res.status).toBe(201);
        await settled();
        await send('POST', '/api/v1/items/sync');
        const roots = (await (await send('GET', '/api/v1/items/roots')).json()) as {
            items: { id: string; title: string; source: string }[];
        };
        const category = roots.items.find((r) => r.source === 'plugin:probe')!;
        expect(category.title).toBe('视频');
        const level1 = (await (await send('GET', `/api/v1/items/${category.id}/children`)).json()) as {
            items: { id: string; title: string }[];
        };
        expect(level1.items.map((i) => i.title)).toEqual(['Video one']);
        const level2 = (await (await send('GET', `/api/v1/items/${level1.items[0]!.id}/children`)).json()) as {
            items: { id: string; title: string }[];
        };
        expect(level2.items.map((i) => i.title)).toEqual(['First clip']);
        const opened = (await (await send('GET', `/api/v1/items/${level2.items[0]!.id}/content`)).json()) as {
            content: string;
        };
        expect(opened.content).toContain('Content of v1-clip');

        // 配额:每个插件最多 50,000 条,超过整批拒绝、什么都不写
        const owner = s.repos.owners.ids()[0]!;
        const granted = s.repos.plugins.get(owner, 'probe')!.granted as never;
        const before = s.repos.items.countBySource(owner, 'plugin:probe');
        for (let i = 0; i < 3; i++) {
            upsertPluginItems(s.repos, owner, 'probe', granted, [
                { id: `p${i}`, type: 'video', title: `P${i}`, hasChildren: false },
            ]);
        }
        expect(s.repos.items.countBySource(owner, 'plugin:probe')).toBe(before + 3);
        const many = Array.from({ length: 500 }, (_, i) => ({
            id: `q${i}`,
            type: 'video',
            title: `Q${i}`,
            hasChildren: false,
        }));
        const insert = s.conn.sqlite.prepare(
            "INSERT INTO items (id, owner_id, kind, type, source, source_ref, title, created_at, updated_at) VALUES (?, ?, 'content', 'video', 'plugin:probe', ?, 'x', 't', 't')",
        );
        s.conn.sqlite.transaction(() => {
            for (let i = 0; i < PLUGIN_ITEM_QUOTA - before - 3; i++) insert.run(`filler${i}`, owner, `n:filler${i}`);
        })();
        expect(() => upsertPluginItems(s.repos, owner, 'probe', granted, many.slice(0, 1))).toThrow(/at most/);
        expect(s.repos.items.countBySource(owner, 'plugin:probe')).toBe(PLUGIN_ITEM_QUOTA);
        // 已存在的条目更新不算新增
        expect(
            upsertPluginItems(s.repos, owner, 'probe', granted, [
                { id: 'p0', type: 'video', title: 'P0 renamed', hasChildren: false },
            ]),
        ).toBe(1);
        // 子项排在父项前面也能挂对(两遍写入);同一批里重复的 id 只算一条
        s.conn.sqlite.prepare("DELETE FROM items WHERE source = 'plugin:probe' AND source_ref LIKE 'n:filler%'").run();
        upsertPluginItems(s.repos, owner, 'probe', granted, [
            { id: 'kid', type: 'video', title: 'Kid', hasChildren: false, parentId: 'dad' },
            { id: 'dad', type: 'video', title: 'Dad', hasChildren: true },
            { id: 'dad', type: 'video', title: 'Dad', hasChildren: true },
        ]);
        const dad = s.repos.items.bySource(owner, 'plugin:probe', 'n:dad')!;
        expect(s.repos.items.parentId(s.repos.items.bySource(owner, 'plugin:probe', 'n:kid')!.id)).toBe(dad.id);

        expect((await send('DELETE', '/api/v1/plugins/probe')).status).toBe(204);
        expect(s.repos.items.countBySource(owner, 'plugin:probe')).toBe(0);
        const after = (await (await send('GET', '/api/v1/items/roots')).json()) as { items: { source: string }[] };
        expect(after.items.some((r) => r.source === 'plugin:probe')).toBe(false);
    }, 60_000);

    it('任务模板只能建草稿(确认前不运行),卸载插件时停用由模板建出的任务', async () => {
        const { send, install, settled } = await setup();
        const src = sourceDir((m) => {
            m.taskTemplates = [
                {
                    title: { en: 'Morning probe', 'zh-CN': '早上探测' },
                    prompt: 'Run the probe tool',
                    trigger: { kind: 'cron', expression: '0 7 * * *' },
                },
            ];
        });
        expect((await install(src)).res.status).toBe(201);
        await settled();
        expect((await send('POST', '/api/v1/tasks/from-plugin-template', { pluginId: 'probe', index: 3 })).status).toBe(
            404,
        );
        const res = await send('POST', '/api/v1/tasks/from-plugin-template', { pluginId: 'probe', index: 0 });
        expect(res.status).toBe(201);
        const draft = (await res.json()) as {
            task: { id: string; name: string; status: string; enabled: boolean; policy: { fromPlugin?: string } };
        };
        expect(draft.task).toMatchObject({
            name: '早上探测',
            status: 'draft',
            enabled: false,
            policy: { fromPlugin: 'probe' },
        });
        // 确认前:草稿不能启用也不能运行
        expect((await send('PATCH', `/api/v1/tasks/${draft.task.id}`, { enabled: true })).status).toBe(409);
        expect((await send('POST', `/api/v1/tasks/${draft.task.id}/run`)).status).toBe(409);
        const detail = PluginDetail.parse(await (await send('GET', '/api/v1/plugins/probe')).json());
        expect(detail.taskTemplates).toHaveLength(1);
        expect(detail.affectedTasks.map((t) => t.id)).toContain(draft.task.id);
        // 停用后不能再从模板建草稿
        await send('PATCH', '/api/v1/plugins/probe', { enabled: false });
        expect((await send('POST', '/api/v1/tasks/from-plugin-template', { pluginId: 'probe', index: 0 })).status).toBe(
            404,
        );
    }, 60_000);

    it('卸载:勾选删除数据后文件树与表行数回到安装前;预授权撤销并审计,任务停用并写原因', async () => {
        const { send, settled, install } = await setup();
        const treeBefore = tree(s.dir);
        const countsBefore = rowCounts();
        await install(sourceDir());
        await settled();
        const owner = s.repos.owners.ids()[0]!;
        s.repos.preauths.create(owner, {
            toolName: 'plugin.probe.echo',
            scope: 'always',
            sessionId: null,
            constraint: null,
        });
        const task = s.repos.tasks.createUser(owner, {
            name: 'uses the plugin',
            trigger: { kind: 'cron', expression: '0 7 * * *' },
            action: { kind: 'agent_prompt', prompt: 'say hi' },
            outputs: [{ kind: 'conversation' }],
            policy: {
                maxAttempts: 1,
                misfire: 'skip',
                quietHours: null,
                maxRuntimeMinutes: 5,
                toolSet: ['plugin.probe.'],
            },
        });
        const detail = PluginDetail.parse(await (await send('GET', '/api/v1/plugins/probe')).json());
        expect(detail.affectedTasks).toEqual([{ id: task.id, name: 'uses the plugin' }]);

        // 先不删除数据:代码目录没了,数据目录与 uninstalled 行还在
        expect((await send('DELETE', '/api/v1/plugins/probe')).status).toBe(204);
        expect(s.repos.plugins.get(owner, 'probe')).toMatchObject({ state: 'uninstalled' });
        expect(Object.keys(tree(s.dir)).some((p) => p.startsWith('/plugin-data/probe'))).toBe(true);
        expect(Object.keys(tree(s.dir)).some((p) => p.startsWith('/plugins/probe'))).toBe(false);
        expect(await (await send('GET', '/api/v1/plugins')).json()).toMatchObject({ items: [] });
        expect(s.repos.preauths.list(owner)).toEqual([]);
        expect(s.repos.audit.list(owner, { limit: 50 }).items.some((a) => a.action === 'preauth-revoked')).toBe(true);
        expect(s.repos.tasks.list(owner)[0]).toMatchObject({ enabled: false, disabledReason: 'plugin_removed' });
        // 任务页能看到原因;用户重新启用后原因清空
        const shown = (await (await send('GET', `/api/v1/tasks/${task.id}`)).json()) as Record<string, unknown>;
        expect(shown).toMatchObject({ enabled: false, disabledReason: 'plugin_removed' });
        const again = await send('PATCH', `/api/v1/tasks/${task.id}`, { enabled: true });
        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ enabled: true, disabledReason: null });

        // 重新安装再卸载并删除数据:回到安装前的快照
        await install(sourceDir());
        await settled();
        expect((await send('DELETE', '/api/v1/plugins/probe?purgeData=true')).status).toBe(204);
        expect(s.repos.plugins.get(owner, 'probe')).toBeNull();
        s.repos.tasks.delete?.(owner, task.id);
        const treeAfter = tree(s.dir);
        delete treeAfter['/plugins/.staging/'];
        delete treeAfter['/plugins/'];
        const before = { ...treeBefore };
        delete before['/plugins/'];
        expect(treeAfter).toEqual(before);
        expect(rowCounts()).toEqual(countsBefore);
        const events = s.repos.plugins.listEvents(owner, { pluginId: 'probe', limit: 50 }).items.map((e) => e.kind);
        expect(events).toEqual(expect.arrayContaining(['installed', 'uninstalled']));
    }, 90_000);
});

describe('protectionTable', () => {
    it('never claims enforced direct-network: the Linux namespace leaves Unix socket files to the preload', () => {
        for (const kind of ['unshare', 'sandbox-exec', 'none'] as const) {
            const direct = protectionTable('linux', true, kind).find((p) => p.key === 'direct-network');
            expect(direct?.level).toBe('layered');
        }
        expect(protectionTable('linux', true, 'unshare').find((p) => p.key === 'direct-network')?.detail).toMatch(
            /Unix socket/,
        );
    });
});
