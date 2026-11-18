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
        permissions: { secrets: unknown };
        settings?: unknown;
    };
    manifest.id = 'weather';
    manifest.name = { 'zh-CN': '天气', en: 'Weather' };
    manifest.description = { 'zh-CN': '查询城市天气预报(测试夹具)', en: 'City weather forecasts (test fixture)' };
    manifest.permissions.secrets = [{ name: 'WEATHER_API_KEY', required: true, description: { en: 'API key' } }];
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

test('plugins page: install, configure, stop, uninstall and see the disabled task', async ({ page }) => {
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

    await card.getByRole('button', { name: '停止' }).click();
    await expect(card).toContainText('已启用');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'plugins-manage.png'), fullPage: true });
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
