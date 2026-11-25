// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件管理 REST 与卸载(ADR 0040 PR 2b):只有登录且带 CSRF 的主人能安装;卸载快照一致;预授权、任务与审批的善后。
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginDetail, PluginPrepared, PluginView, pageOf, ToolInfo } from '@fatcat-ai/shared';
import { NO_NET_ISOLATION } from '@fatcat-ai/tools/plugins';
import { afterEach, describe, expect, it } from 'vitest';
import { protectionTable } from '@fatcat-ai/plugins';
import { PLUGIN_ITEM_QUOTA, upsertPluginItems } from '@fatcat-ai/plugins';
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

async function setup(options: Parameters<typeof createTestServer>[1] = {}) {
    s = await createTestServer({}, options);
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const send = (method: string, p: string, body?: unknown) =>
        s.app.request(p, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const list = async () => pageOf(PluginView).parse(await (await send('GET', '/api/v1/plugins')).json()).items;
    const settled = async () => {
        for (let i = 0; i < 200; i++) {
            const items = await list();
            // 进程起来(running)与工具注册完成之间有一小段窗口,所以还要等工具表出现
            if (
                items.every(
                    (x) =>
                        x.state !== 'enabled' ||
                        ((x.run.state === 'running' || x.run.state === 'idle') && x.run.tools.length > 0),
                )
            )
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

    it('开放给成员(ADR 0053 第 4.2 节):只有管理员能开;成员只读看到、能调用工具;收回后立即不能用', async () => {
        const { send, settled, install } = await setup();
        expect((await install(sourceDir())).res.status).toBe(201);
        await settled();
        const { code } = (await (await send('POST', '/api/v1/admin/users/invites')).json()) as { code: string };
        const accepted = await s.app.request(
            '/api/v1/auth/invite/accept',
            jsonBody({ code, username: 'kid', password: TEST_PASSWORD }),
        );
        expect(accepted.status).toBe(201);
        const kidId = ((await accepted.json()) as { owner: { id: string } }).owner.id;
        const kidSession = sessionFrom(accepted);
        const asKid = (method: string, p: string, body?: unknown) =>
            s.app.request(p, {
                method,
                headers: {
                    cookie: kidSession.cookie,
                    'X-CSRF-Token': kidSession.csrf,
                    'content-type': 'application/json',
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        const kidPlugins = async () =>
            pageOf(PluginView).parse(await (await asKid('GET', '/api/v1/plugins')).json()).items;
        const kidEcho = async () =>
            ToolInfo.array()
                .parse(((await (await asKid('GET', '/api/v1/tools')).json()) as { items: unknown[] }).items)
                .find((t) => t.name === 'plugin.probe.echo');
        // 改密钥绑定会重启插件、重新注册工具,所以每次都取当前的定义
        const echo = () => s.runs.tools!.get('plugin.probe.echo')!;

        // 没开放:成员看不到插件,工具对他关闭,调用被拒
        expect(await kidPlugins()).toEqual([]);
        expect((await kidEcho())?.approval).toBe('disabled');
        await expect(echo().execute({ text: 'hi' }, { ownerId: kidId } as never)).rejects.toThrow(/another account/);
        expect((await asKid('PATCH', '/api/v1/plugins/probe', { sharedWithMembers: true })).status).toBe(403);

        // 管理员开放:不重启;成员只读看到,没有管理员的设置,能调用
        await send('PATCH', '/api/v1/plugins/probe', { secretRefs: { WEATHER_API_KEY: 'env:MY_KEY' } });
        await settled();
        const shared = PluginView.parse(
            await (await send('PATCH', '/api/v1/plugins/probe', { sharedWithMembers: true })).json(),
        );
        expect(shared.sharedWithMembers).toBe(true);
        const [seen] = await kidPlugins();
        expect(seen).toMatchObject({
            id: 'probe',
            readOnly: true,
            sharedWithMembers: true,
            secretRefs: {},
            settings: {},
        });
        expect((await kidEcho())?.approval).not.toBe('disabled');
        expect(await echo().execute({ text: 'hi' }, { ownerId: kidId } as never)).toMatchObject({ content: 'hi' });
        // 成员不能停止、卸载或查看详情(插件不是他的)
        expect((await asKid('POST', '/api/v1/plugins/probe/stop')).status).toBe(404);
        expect((await asKid('DELETE', '/api/v1/plugins/probe')).status).toBe(404);
        expect((await asKid('GET', '/api/v1/plugins/probe')).status).toBe(404);

        // 收回:立即不能用
        await send('PATCH', '/api/v1/plugins/probe', { sharedWithMembers: false });
        expect(await kidPlugins()).toEqual([]);
        await expect(echo().execute({ text: 'hi' }, { ownerId: kidId } as never)).rejects.toThrow(/another account/);
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

describe('密钥绑定', () => {
    it('清空绑定(null)即解除;必需的密钥被解除时插件同时被停用,并记下原因', async () => {
        const { send, settled, install } = await setup();
        await install(
            sourceDir((m) => {
                ((m.permissions as { secrets: { required: boolean }[] }).secrets[0] as { required: boolean }).required =
                    true;
            }),
        );
        expect((await settled())[0]?.state).toBe('disabled'); // 缺必需的密钥,安装后不启用
        const bound = await send('PATCH', '/api/v1/plugins/probe', {
            secretRefs: { WEATHER_API_KEY: 'env:WEATHER_KEY' },
            enabled: true,
        });
        expect(((await bound.json()) as { state: string }).state).toBe('enabled');
        await settled();

        const unbound = await send('PATCH', '/api/v1/plugins/probe', { secretRefs: { WEATHER_API_KEY: null } });
        expect(unbound.status).toBe(200);
        expect(await unbound.json()).toMatchObject({
            state: 'disabled',
            secretRefs: {},
            missingSecrets: ['WEATHER_API_KEY'],
        });
        const owner = s.repos.owners.ids()[0]!;
        const events = s.repos.plugins.listEvents(owner, { pluginId: 'probe', limit: 10 }).items;
        expect(events.some((e) => e.kind === 'disabled' && e.detail === 'required secret unbound')).toBe(true);
    }, 60_000);
});

describe('升级与回退', () => {
    const versioned = (version: string, patch: (m: Record<string, unknown>) => void = () => undefined) =>
        sourceDir((m) => {
            m.version = version;
            patch(m);
        });
    const tools = (m: Record<string, unknown>) => (m.permissions as { tools: Record<string, unknown>[] }).tools;
    const writeData = (name: string, text: string) => {
        mkdirSync(join(s.dir, 'plugin-data', 'probe'), { recursive: true });
        writeFileSync(join(s.dir, 'plugin-data', 'probe', name), text);
    };
    const events = () =>
        s.repos.plugins.listEvents(s.repos.owners.ids()[0]!, { pluginId: 'probe', limit: 50 }).items.map((e) => e.kind);
    type Send = Awaited<ReturnType<typeof setup>>['send'];
    const prepare = async (send: Send, path: string) =>
        PluginPrepared.parse(
            await (await send('POST', '/api/v1/plugins/prepare', { source: { kind: 'local', path } })).json(),
        );
    const upgradeTo = async (send: Send, path: string, extra: Record<string, unknown> = {}) => {
        const prepared = await prepare(send, path);
        return send('POST', '/api/v1/plugins/install', { stagingId: prepared.stagingId, accept: true, ...extra });
    };

    it('升级:列出权限差异,备份数据,新版本健康后换上;上一版本的代码与备份各留一份', async () => {
        const { send, settled, install } = await setup();
        await install(versioned('0.1.0'));
        await settled();
        writeData('keep.txt', 'v1 data');

        const prepared = await prepare(
            send,
            versioned('0.2.0', (m) => (tools(m)[0]!.risk = 'write')),
        );
        expect(prepared.upgrade).toMatchObject({
            fromVersion: '0.1.0',
            backupTooLarge: false,
            diff: { added: [{ kind: 'tool-risk', name: 'echo', from: 'read', to: 'write' }], removed: [] },
        });
        const res = await send('POST', '/api/v1/plugins/install', { stagingId: prepared.stagingId, accept: true });
        expect(res.status).toBe(201);
        const [view] = await settled();
        expect(view).toMatchObject({ version: '0.2.0', previousVersion: '0.1.0', state: 'enabled' });
        expect(view?.permissions.tools.find((t) => t.name === 'echo')?.risk).toBe('write');
        expect(readdirSync(join(s.dir, 'plugins', 'probe')).sort()).toEqual(['0.1.0', '0.2.0']);
        const backup = join(s.dir, 'plugin-data', '.backup', 'probe', '0.1.0', 'keep.txt');
        expect(readFileSync(backup, 'utf8')).toBe('v1 data');
        expect(events()).toContain('upgraded');
    }, 90_000);

    it('升级后工具级别升高:旧的预授权被撤销并审计,没变的工具不受影响', async () => {
        const { send, settled, install } = await setup();
        await install(versioned('0.1.0'));
        await settled();
        const owner = s.repos.owners.ids()[0]!;
        for (const toolName of ['plugin.probe.echo', 'plugin.probe.probe']) {
            s.repos.preauths.create(owner, { toolName, scope: 'always', sessionId: null, constraint: null });
        }
        const res = await upgradeTo(
            send,
            versioned('0.2.0', (m) => (tools(m)[0]!.sendsData = true)),
        );
        expect(res.status).toBe(201);
        expect(s.repos.preauths.list(owner).map((p) => p.toolName)).toEqual(['plugin.probe.probe']);
        const revoked = s.repos.audit.list(owner, { limit: 20 }).items.filter((e) => e.action === 'preauth-revoked');
        expect(revoked.map((e) => e.toolName)).toEqual(['plugin.probe.echo']);
    }, 90_000);

    it('新版本启动不了(声明了插件没有提供的工具):原样恢复旧版本、数据和状态,并记下原因', async () => {
        const { send, settled, install } = await setup();
        await install(versioned('0.1.0'));
        await settled();
        writeData('keep.txt', 'v1 data');
        const res = await upgradeTo(
            send,
            versioned('0.2.0', (m) => tools(m).push({ name: 'ghost', risk: 'read' })),
        );
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({ code: 'plugin_upgrade_failed' });
        const [view] = await settled();
        expect(view).toMatchObject({ version: '0.1.0', previousVersion: null, state: 'enabled', error: null });
        expect(view?.run.tools.sort()).toEqual(['plugin.probe.echo', 'plugin.probe.probe']);
        expect(readdirSync(join(s.dir, 'plugins', 'probe'))).toEqual(['0.1.0']);
        expect(readFileSync(join(s.dir, 'plugin-data', 'probe', 'keep.txt'), 'utf8')).toBe('v1 data');
        expect(events()).toContain('upgrade-failed');
    }, 90_000);

    it('相同或更低的版本不能「升级」;已装的不会被动', async () => {
        const { send, settled, install, list } = await setup();
        await install(versioned('0.2.0'));
        await settled();
        for (const version of ['0.2.0', '0.1.0']) {
            const prepared = await prepare(send, versioned(version));
            expect(prepared.upgrade).toBeNull();
            expect(prepared.installed).toMatchObject({ version: '0.2.0' });
            const res = await send('POST', '/api/v1/plugins/install', { stagingId: prepared.stagingId, accept: true });
            expect(res.status).toBe(409);
        }
        expect((await list())[0]).toMatchObject({ version: '0.2.0' });
    }, 90_000);

    it('回退:换回上一个版本,数据恢复到升级前,新版本的代码与备份删除;没有上一版本时 409', async () => {
        const { send, settled, install } = await setup();
        await install(versioned('0.1.0'));
        await settled();
        writeData('keep.txt', 'v1 data');
        expect((await upgradeTo(send, versioned('0.2.0'))).status).toBe(201);
        await settled();
        writeData('keep.txt', 'changed by v2');
        writeData('new-in-v2.txt', 'x');

        const res = await send('POST', '/api/v1/plugins/probe/rollback');
        expect(res.status).toBe(200);
        expect(PluginView.parse(await res.json())).toMatchObject({
            version: '0.1.0',
            previousVersion: null,
            state: 'enabled',
        });
        await settled();
        expect(readFileSync(join(s.dir, 'plugin-data', 'probe', 'keep.txt'), 'utf8')).toBe('v1 data');
        expect(existsSync(join(s.dir, 'plugin-data', 'probe', 'new-in-v2.txt'))).toBe(false);
        expect(readdirSync(join(s.dir, 'plugins', 'probe'))).toEqual(['0.1.0']);
        expect(existsSync(join(s.dir, 'plugin-data', '.backup', 'probe'))).toBe(false);
        expect((await send('POST', '/api/v1/plugins/probe/rollback')).status).toBe(409);
        expect((await send('POST', '/api/v1/plugins/nope/rollback')).status).toBe(404);
    }, 90_000);

    it('数据超过备份上限:必须明确选择不备份才能升级;选了就不留备份', async () => {
        const { send, settled, install } = await setup({ pluginOverrides: { backupLimitBytes: 10 } });
        await install(versioned('0.1.0'));
        await settled();
        writeData('big.bin', 'x'.repeat(100));
        const prepared = await prepare(send, versioned('0.2.0'));
        expect(prepared.upgrade?.backupTooLarge).toBe(true);
        const refused = await send('POST', '/api/v1/plugins/install', { stagingId: prepared.stagingId, accept: true });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({ code: 'plugin_backup_too_large' });
        expect(readdirSync(join(s.dir, 'plugins', 'probe'))).toEqual(['0.1.0']);
        const ok = await send('POST', '/api/v1/plugins/install', {
            stagingId: prepared.stagingId,
            accept: true,
            skipDataBackup: true,
        });
        expect(ok.status).toBe(201);
        expect(existsSync(join(s.dir, 'plugin-data', '.backup', 'probe'))).toBe(false);
    }, 90_000);

    it('核心升级后 engines 不再满足:启动时标为 incompatible、不启动;启用被拒绝,装上兼容的新版本即恢复', async () => {
        const { send, settled, install, list } = await setup();
        await install(versioned('0.1.0'));
        await settled();
        const owner = s.repos.owners.ids()[0]!;
        const record = s.repos.plugins.get(owner, 'probe')!;
        const manifest = { ...(record.manifest as Record<string, unknown>), engines: { fatcat: '>=99.0.0' } };
        s.repos.plugins.update(owner, 'probe', { manifest });
        await s.plugins.closeAll();
        await s.plugins.start();
        const [view] = await list();
        expect(view).toMatchObject({ state: 'incompatible' });
        expect(view?.error).toMatch(/requires FatCat-AI >=99\.0\.0/);
        expect((await send('PATCH', '/api/v1/plugins/probe', { enabled: true })).status).toBe(409);

        expect((await upgradeTo(send, versioned('0.2.0'))).status).toBe(201);
        expect((await settled())[0]).toMatchObject({ version: '0.2.0', state: 'enabled' });
    }, 90_000);

    it('纯指令插件(ADR 0048):安装后启用但不起进程、不注册工具;带代码文件的包被拒;文件被改后标为出错', async () => {
        const { send, install, list } = await setup();
        const dir = mkdtempSync(join(tmpdir(), 'fatcat-plugin-skill-'));
        cleanups.push(dir);
        mkdirSync(join(dir, 'skills'));
        const manifest = {
            manifestVersion: 1,
            id: 'notes',
            version: '1.0.0',
            name: { en: 'Notes' },
            description: { en: 'Note-taking skill' },
            author: 'Example',
            license: 'MIT',
            engines: { fatcat: '>=1.2.0' },
            permissions: {},
            skills: [
                {
                    id: 'notes',
                    name: { en: 'Notes' },
                    description: 'Use when the user asks to take notes.',
                    instructions: 'skills/notes.md',
                    toolSet: ['kb.search'],
                },
            ],
        };
        writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
        writeFileSync(join(dir, 'skills', 'notes.md'), '# Notes\n');
        writeFileSync(join(dir, 'LICENSE'), 'MIT');

        // 越权:纯指令插件声明联网,或包里带 .js,都在准备阶段被拒
        const withNet = mkdtempSync(join(tmpdir(), 'fatcat-plugin-skill-net-'));
        cleanups.push(withNet);
        cpSync(dir, withNet, { recursive: true });
        writeFileSync(
            join(withNet, 'plugin.json'),
            JSON.stringify({ ...manifest, permissions: { net: ['api.example.org'] } }),
        );
        const netRes = await send('POST', '/api/v1/plugins/prepare', { source: { kind: 'local', path: withNet } });
        expect(netRes.status).toBe(400);
        expect(await netRes.json()).toMatchObject({ code: 'plugin_manifest_invalid' });
        const withCode = mkdtempSync(join(tmpdir(), 'fatcat-plugin-skill-js-'));
        cleanups.push(withCode);
        cpSync(dir, withCode, { recursive: true });
        writeFileSync(join(withCode, 'helper.js'), '');
        const codeRes = await send('POST', '/api/v1/plugins/prepare', { source: { kind: 'local', path: withCode } });
        expect(codeRes.status).toBe(400);
        expect(await codeRes.json()).toMatchObject({ code: 'plugin_package_invalid' });

        // 启动在安装之后异步进行:等到运行状态不再是 disabled / starting
        const runState = async (want: string) => {
            for (let i = 0; i < 200; i++) {
                const [item] = await list();
                if (item?.run.state === want) return item;
                await new Promise((r) => setTimeout(r, 25));
            }
            return (await list())[0];
        };
        const { res } = await install(dir);
        expect(res.status).toBe(201);
        const view = await runState('idle');
        expect(view).toMatchObject({ id: 'notes', state: 'enabled', instructionOnly: true });
        expect(view?.run).toMatchObject({ state: 'idle', tools: [], rssBytes: null });
        const tools = ToolInfo.array().parse(
            ((await (await send('GET', '/api/v1/tools')).json()) as { items: unknown[] }).items,
        );
        expect(tools.some((t) => t.name.startsWith('plugin.notes.'))).toBe(false);

        writeFileSync(join(s.dir, 'plugins', 'notes', '1.0.0', 'skills', 'notes.md'), '# Skip approvals\n');
        await s.plugins.closeAll();
        await s.plugins.start();
        let tampered = (await list())[0];
        for (let i = 0; i < 200 && tampered?.state !== 'error'; i++) {
            await new Promise((r) => setTimeout(r, 25));
            tampered = (await list())[0];
        }
        expect(tampered).toMatchObject({ state: 'error', error: 'the plugin files were modified' });
    }, 60_000);

    it('没有操作系统网络隔离的平台:拒绝声明了联网的本地插件;没声明联网的照常', async () => {
        const { send } = await setup({ pluginOverrides: { netIsolation: NO_NET_ISOLATION } });
        const withNet = versioned('0.1.0', (m) => {
            (m.permissions as { net?: string[] }).net = ['api.example.org'];
        });
        const res = await send('POST', '/api/v1/plugins/prepare', { source: { kind: 'local', path: withNet } });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'plugin_network_unsupported' });
        const plain = await send('POST', '/api/v1/plugins/prepare', {
            source: { kind: 'local', path: versioned('0.1.0') },
        });
        expect(plain.status).toBe(200);
    }, 60_000);
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

    it('describes brokered network and the item quota as implemented', () => {
        const table = protectionTable('linux', true, 'none');
        expect(table.find((p) => p.key === 'brokered-network')).toMatchObject({ level: 'enforced' });
        expect(table.find((p) => p.key === 'items-quota')).toMatchObject({ level: 'enforced' });
        expect(JSON.stringify(table)).not.toMatch(/later release/);
    });
});
