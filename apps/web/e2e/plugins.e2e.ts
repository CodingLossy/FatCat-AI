// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件页冒烟(ADR 0040 PR 2c):从本地目录检查并安装(先看权限与保护程度表)、绑定密钥、保存设置、停止、停用、
// 卸载对话框列出受影响任务、任务页显示「插件已卸载」。测试夹具 probe 插件不联网,不需要任何真实服务。
import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = join(here, '../../server/dist/index.js');
const WEB_DIST = join(here, '../dist');
const FIXTURES = join(here, '../../../packages/tools/src/plugins/fixtures');
const PASSWORD = 'correct horse battery staple';
const SHOTS = process.env.FATCAT_SHOTS_DIR;

let dir = '';
let pluginDir = '';
let server: ChildProcess | undefined;
let base = '';

async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const { port } = s.address() as AddressInfo;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
}

test.beforeAll(async () => {
    expect(existsSync(SERVER_ENTRY), 'build apps/server first').toBe(true);
    expect(existsSync(join(WEB_DIST, 'index.html')), 'build apps/web first').toBe(true);
    dir = mkdtempSync(join(tmpdir(), 'fatcat-plugins-e2e-'));
    pluginDir = join(dir, 'weather-plugin');
    cpSync(FIXTURES, pluginDir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8')) as Record<string, unknown> & {
        permissions: Record<string, unknown>;
        settings?: unknown;
        taskTemplates?: unknown;
    };
    manifest.id = 'weather';
    manifest.name = { 'zh-CN': '天气', en: 'Weather' };
    manifest.description = { 'zh-CN': '查询城市天气预报(测试夹具)', en: 'City weather forecasts (test fixture)' };
    manifest.permissions.secrets = [{ name: 'WEATHER_API_KEY', required: true, description: { en: 'API key' } }];
    manifest.permissions.items = { categories: [{ type: 'video', title: { 'zh-CN': '视频', en: 'Videos' } }] };
    manifest.taskTemplates = [
        {
            title: { 'zh-CN': '早上探测', en: 'Morning probe' },
            prompt: '用 probe 工具检查一下',
            trigger: { kind: 'cron', expression: '0 7 * * *' },
        },
    ];
    manifest.settings = {
        type: 'object',
        properties: {
            city: { type: 'string', title: { 'zh-CN': '城市', en: 'City' }, default: '上海', maxLength: 20 },
            unit: { type: 'string', title: { 'zh-CN': '温度单位', en: 'Unit' }, enum: ['c', 'f'], default: 'c' },
            days: { type: 'number', title: { 'zh-CN': '预报天数', en: 'Days' }, minimum: 1, maximum: 7 },
            alerts: { type: 'boolean', title: { 'zh-CN': '极端天气提醒', en: 'Alerts' } },
        },
        required: ['city'],
    };
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [SERVER_ENTRY], {
        env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            FATCAT_AI_PORT: String(port),
            FATCAT_AI_HOST: '127.0.0.1',
            FATCAT_AI_DATA_DIR: join(dir, 'data'),
            FATCAT_AI_WEB_DIR: WEB_DIST,
            FATCAT_AI_LOG_LEVEL: 'error',
            E2E_WEATHER_KEY: 'not-a-real-key',
        },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    for (let i = 0; i < 100; i++) {
        const ok = await fetch(`${base}/healthz`).then(
            (r) => r.ok,
            () => false,
        );
        if (ok) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not become healthy');
});

test.afterAll(async () => {
    if (server && server.exitCode === null) {
        const exited = new Promise((r) => server!.once('exit', r));
        server.kill();
        await exited;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
});

test('plugins page: install, configure, stop, uninstall and see the disabled task', async ({ page, browser }) => {
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();
    const csrf = (await page.context().cookies()).find((c) => c.name.toLowerCase().includes('csrf'))?.value ?? '';
    await page.getByRole('link', { name: '插件' }).click();
    await expect(page.getByText('还没有安装插件。')).toBeVisible();

    // 检查:只复制并检查,显示权限与保护程度表;不勾选同意就不能安装
    await page.getByLabel('插件目录', { exact: false }).fill(pluginDir);
    await page.getByRole('button', { name: '检查' }).click();
    const confirm = page.getByTestId('plugin-confirm');
    await expect(confirm).toContainText('安装「天气」?');
    await expect(confirm).toContainText('WEATHER_API_KEY');
    await expect(confirm.getByTestId('plugin-protections').locator('tr')).toHaveCount(9);
    await expect(confirm.locator('[data-protection="direct-network"]')).toContainText('多层防护');
    await expect(confirm.locator('[data-protection="brokered-network"]')).toContainText('强制');
    await expect(confirm.locator('[data-protection="brokered-network"]')).not.toContainText('later release');
    await expect(confirm.locator('[data-protection="items-quota"]')).toContainText('强制');
    await expect(confirm).toContainText('没有经过市场审核');
    await expect(confirm.getByRole('button', { name: '安装' })).toBeDisabled();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'plugins-confirm.png'), fullPage: true });
    await confirm.getByRole('checkbox').check();
    await confirm.getByRole('button', { name: '安装' }).click();

    // 必需的密钥没绑定:安装后是停用的,启用按钮不可点
    const card = page.locator('[data-plugin="weather"]');
    await expect(card).toContainText('已停用');
    await expect(card.getByRole('button', { name: '启用' })).toBeDisabled();
    await expect(card.getByTestId('plugin-manage')).toBeVisible();
    await expect(card.getByTestId('plugin-secrets')).toContainText('还缺少必需的密钥');

    // 写法不对给提示;绑定环境变量引用后可以启用
    const secrets = card.getByTestId('plugin-secrets');
    await secrets.getByLabel('WEATHER_API_KEY').fill('sk-oops');
    await expect(secrets).toContainText('env:');
    await expect(secrets.getByRole('button', { name: '保存' })).toBeDisabled();
    await secrets.getByLabel('WEATHER_API_KEY').fill('env:E2E_WEATHER_KEY');
    await secrets.getByRole('button', { name: '保存' }).click();
    await expect(card.getByRole('button', { name: '启用' })).toBeEnabled();

    // 设置表单:按清单的 settings 渲染,默认值预填;服务器校验
    const settings = card.getByTestId('plugin-settings');
    await expect(settings.getByLabel('城市')).toHaveValue('上海');
    await settings.getByLabel('城市').fill('北京');
    await settings.getByLabel('预报天数').fill('3');
    await settings.getByLabel('极端天气提醒').check();
    await settings.getByRole('button', { name: '保存' }).click();
    await expect(settings.getByLabel('预报天数')).toHaveValue('3');

    // 内存设置
    const runtime = card.getByTestId('plugin-runtime');
    await runtime.getByLabel('内存阈值').fill('256');
    await runtime.getByRole('button', { name: '保存' }).click();

    // 启用 → 运行;停止 → 空闲;停用
    await card.getByRole('button', { name: '启用' }).click();
    await expect(card).toContainText('已启用');

    await expect(card).toContainText(/运行中|空闲/);
    // 工具注册后才能建引用它的任务(未知前缀会被拒绝);卸载对话框要列出它
    const created = await page.request.post(`${base}/api/v1/tasks`, {
        headers: { 'X-CSRF-Token': csrf },
        data: {
            name: '每天看天气',
            trigger: { kind: 'cron', expression: '0 7 * * *' },
            action: { kind: 'agent_prompt', prompt: '查一下天气' },
            policy: {
                maxAttempts: 1,
                misfire: 'skip',
                quietHours: null,
                maxRuntimeMinutes: 5,
                toolSet: ['plugin.weather.'],
            },
        },
    });
    expect(created.ok(), await created.text()).toBe(true);

    // 知识地图:插件的类别出现在浏览器里,能下钻并打开;条目内容由插件提供
    await page.goto(`${base}/items`);
    await page.getByRole('button', { name: '立即同步' }).click();
    await page.getByRole('button', { name: '视频', exact: true }).first().click();
    await page.locator('.item-row').filter({ hasText: 'Video one' }).click();
    await page.locator('.item-row').filter({ hasText: 'First clip' }).click();
    await expect(page.locator('.item-text')).toContainText('Content of v1-clip');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'plugins-items.png'), fullPage: true });

    // 任务模板:只能建成草稿,在任务页的确认卡上确认;放弃它,不影响后面的卸载检查
    await page.getByRole('link', { name: '插件' }).click();
    await card.getByRole('button', { name: '管理' }).click();
    await card.getByTestId('plugin-templates').getByRole('button', { name: '建成任务草稿' }).click();
    await expect(page.getByTestId('draft-from-plugin')).toContainText('weather');
    await expect(page.getByRole('button', { name: '确认并启用' })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'plugins-template-draft.png'), fullPage: true });
    await page.getByRole('button', { name: '丢弃' }).click();
    await page.getByRole('link', { name: '插件' }).click();
    await card.getByRole('button', { name: '管理' }).click();

    await card.getByRole('button', { name: '停止' }).click();
    await expect(card).toContainText('已启用');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'plugins-manage.png'), fullPage: true });

    // 开放给成员(ADR 0053 第 4.2 节):成员只读看到它,没有按钮,也看不到管理员的密钥绑定
    await card.getByRole('checkbox', { name: '开放给成员' }).click();
    await expect(card.getByTestId('plugin-shared')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'plugin-share-admin.png'), fullPage: true });
    const invite = await page.request.post(`${base}/api/v1/admin/users/invites`, { headers: { 'X-CSRF-Token': csrf } });
    const { code } = (await invite.json()) as { code: string };
    const memberContext = await browser.newContext();
    const member = await memberContext.newPage();
    await member.goto(base);
    await member.getByRole('button', { name: '有邀请码' }).click();
    await member.getByLabel('邀请码').fill(code);
    await member.getByLabel('用户名').fill('kid');
    await member.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await member.getByRole('button', { name: '创建账户并登录' }).click();
    await member.getByRole('link', { name: '插件' }).click();
    const shared = member.locator('[data-plugin="weather"]');
    await expect(shared.getByTestId('plugin-shared-by-admin')).toBeVisible();
    await expect(shared.getByRole('button', { name: '停用' })).toBeHidden();
    await expect(shared.getByRole('button', { name: '管理' })).toBeHidden();
    // 成员没有安装入口和市场
    await expect(member.getByRole('tab', { name: '市场' })).toBeHidden();
    await expect(member.getByRole('button', { name: '检查' })).toBeHidden();
    await expect(shared).not.toContainText('E2E_WEATHER_KEY');
    if (SHOTS) await member.screenshot({ path: join(SHOTS, 'plugin-share-member.png'), fullPage: true });
    await card.getByRole('checkbox', { name: '开放给成员' }).click();
    await expect(card.getByTestId('plugin-shared')).toHaveCount(0);
    await member.reload();
    await expect(member.locator('[data-plugin="weather"]')).toHaveCount(0);
    await memberContext.close();

    await card.getByRole('button', { name: '停用' }).click();
    await expect(card).toContainText('已停用');

    // 卸载对话框:列出受影响任务与备份提示
    await card.getByRole('button', { name: '卸载' }).click();
    const dialog = card.getByTestId('plugin-uninstall');
    await expect(dialog.getByTestId('plugin-affected-tasks')).toContainText('每天看天气');
    await expect(dialog).toContainText('不在自动备份里');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'plugins-uninstall.png'), fullPage: true });
    await dialog.getByRole('button', { name: '卸载' }).click();
    await expect(page.getByText('还没有安装插件。')).toBeVisible();

    // 任务页显示原因
    await page.getByRole('link', { name: '任务' }).click();
    await expect(page.getByTestId('task-disabled-reason')).toContainText('插件被卸载而停用');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'plugins-task-disabled.png'), fullPage: true });
});

/** 升级用的夹具:同一个插件 id 的不同版本;`patch` 改清单。 */
function versionDir(
    version: string,
    patch: (manifest: Record<string, unknown> & { permissions: { tools: Record<string, unknown>[] } }) => void = () =>
        undefined,
): string {
    const target = join(dir, `tides-${version}`);
    cpSync(FIXTURES, target, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(target, 'plugin.json'), 'utf8')) as Record<string, unknown> & {
        permissions: { tools: Record<string, unknown>[] };
    };
    manifest.id = 'tides';
    manifest.version = version;
    manifest.name = { 'zh-CN': '潮汐', en: 'Tides' };
    patch(manifest);
    writeFileSync(join(target, 'plugin.json'), JSON.stringify(manifest));
    return target;
}

test('plugins page: upgrade shows the permission diff, a failed upgrade is undone, and rollback restores the old version', async ({
    page,
}) => {
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    // 单独跑这个用例时还没有账号:走创建账号;否则登录
    const create = page.getByRole('button', { name: '创建并登录' });
    const login = page.getByRole('button', { name: '登录', exact: true });
    await create.or(login).first().waitFor();
    await ((await create.isVisible()) ? create : login).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();
    await page.getByRole('link', { name: '插件' }).click();

    const check = async (path: string) => {
        await page.getByLabel('插件目录', { exact: false }).fill(path);
        await page.getByRole('button', { name: '检查' }).click();
    };
    const confirm = page.getByTestId('plugin-confirm');
    const card = page.locator('[data-plugin="tides"]');

    // 先装 0.1.0
    await check(versionDir('0.1.0'));
    await confirm.getByRole('checkbox').check();
    await confirm.getByRole('button', { name: '安装', exact: true }).click();
    await expect(card).toContainText('v0.1.0');
    await expect(card).toContainText('已启用');

    // 0.2.0:echo 升到 write 并开始外发数据,probe 工具不再声明
    await check(
        versionDir('0.2.0', (m) => {
            m.permissions.tools = [{ name: 'echo', risk: 'write', sendsData: true }];
        }),
    );
    await expect(confirm).toContainText('升级「潮汐」?');
    await expect(confirm.getByTestId('plugin-upgrade')).toContainText('从 v0.1.0 升级到 v0.2.0');
    await expect(confirm.getByTestId('plugin-diff-added')).toContainText('工具 echo 的级别从 read 升到 write');
    await expect(confirm.getByTestId('plugin-diff-added')).toContainText('会把你的数据发到外部服务');
    await expect(confirm.getByTestId('plugin-diff-removed')).toContainText('不再提供工具 probe');
    await expect(confirm.getByRole('button', { name: '升级', exact: true })).toBeDisabled();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'plugin-upgrade-confirm.png'), fullPage: true });
    await confirm.getByRole('checkbox').check();
    await confirm.getByRole('button', { name: '升级', exact: true }).click();
    await expect(card).toContainText('v0.2.0');
    await expect(card).toContainText('已启用');

    // 升级后可以回退;回退要再确认一次
    const rollback = card.getByTestId('plugin-rollback'); // 安装或升级后卡片自动展开
    await expect(rollback).toContainText('上一个版本 v0.1.0 还在');
    await rollback.getByRole('button', { name: '回退到 v0.1.0' }).click();
    await expect(rollback).toContainText('恢复到升级前');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'plugin-rollback-confirm.png'), fullPage: true });
    await rollback.getByRole('button', { name: '确认回退' }).click();
    await expect(card).toContainText('v0.1.0');
    await expect(card.getByTestId('plugin-rollback')).toHaveCount(0);

    // 新版本启动不了(声明了插件没有的工具):提示原因,旧版本原样还在
    await check(
        versionDir('0.3.0', (m) => {
            m.permissions.tools.push({ name: 'ghost', risk: 'read' });
        }),
    );
    await expect(confirm).toContainText('升级「潮汐」?');
    await confirm.getByRole('checkbox').check();
    await confirm.getByRole('button', { name: '升级', exact: true }).click();
    await expect(page.locator('p.error')).toContainText('health check');
    await expect(card).toContainText('v0.1.0');
    await expect(card).toContainText('已启用');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'plugin-upgrade-failed.png'), fullPage: true });
});
