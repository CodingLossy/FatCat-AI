// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置页(M12 PR 6):浏览器开关默认关闭并可打开;分区标签是 tablist / tabpanel,方向键切换;语音页有自动发送 / 自动朗读开关。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = join(here, '../../server/dist/index.js');
const WEB_DIST = join(here, '../dist');
const SHOTS = process.env.FATCAT_SHOTS_DIR;
const PASSWORD = 'correct horse battery staple';

let dir = '';
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-settings-browser-e2e-'));
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

async function shot(page: import('@playwright/test').Page, name: string) {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test('设置:浏览器开关、分区标签的键盘操作、语音页开关', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 820 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await page.getByRole('link', { name: '设置', exact: true }).click();

    // 分区标签:tablist + tabpanel,只有选中的标签在 Tab 顺序里,方向键 / Home / End 切换并移动焦点
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(4);
    const panel = page.getByRole('tabpanel');
    await expect(panel).toBeVisible();
    const models = page.getByRole('tab', { name: /模型与语音/ });
    await expect(models).toHaveAttribute('aria-selected', 'true');
    await expect(models).toHaveAttribute('tabindex', '0');
    await expect(page.getByRole('tab', { name: /工具插件/ })).toHaveAttribute('tabindex', '-1');
    await models.focus();
    await page.keyboard.press('ArrowRight');
    const tools = page.getByRole('tab', { name: /工具插件/ });
    await expect(tools).toHaveAttribute('aria-selected', 'true');
    await expect(tools).toBeFocused();
    await expect(panel).toHaveAttribute('aria-labelledby', (await tools.getAttribute('id')) as string);
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: /系统/ })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /工作台/ })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: /系统/ })).toHaveAttribute('aria-selected', 'true');
    await shot(page, 'settings-tabs-keyboard');

    // 语音页:自动发送 / 自动朗读开关回到这里(原名称)
    await page.getByRole('tab', { name: /模型与语音/ }).click();
    await page.getByRole('button', { name: '语音', exact: true }).click();
    const autoSend = page.locator('input[name="voiceAutoSend"]');
    const autoSpeak = page.locator('input[name="voiceAutoSpeak"]');
    await expect(autoSend).toBeChecked();
    await expect(autoSpeak).not.toBeChecked();
    await autoSpeak.click();
    await expect(autoSpeak).toBeChecked();
    await expect
        .poll(async () => (await (await page.request.get(`${base}/api/v1/settings`)).json()).voice.autoSpeak)
        .toBe(true);
    await shot(page, 'settings-voice-page');
    // 概览里不再有语音交互卡片
    await page.getByRole('button', { name: '概览' }).click();
    await expect(page.getByTestId('card-voice-interaction')).toHaveCount(0);
    await expect(page.getByTestId('settings-cards')).toBeVisible();
    await shot(page, 'settings-overview');

    // 浏览器开关:默认关闭,打开后写入设置,工具列表里的 browser.open 变为需审批
    await page.getByRole('tab', { name: /工具插件/ }).click();
    await page.getByRole('navigation', { name: '工具插件' }).getByRole('button', { name: '浏览器' }).click();
    const enabled = page.locator('input[name="browserEnabled"]');
    await expect(enabled).not.toBeChecked();
    const toolInfo = async () =>
        (
            (await (await page.request.get(`${base}/api/v1/tools`)).json()) as {
                items: { name: string; approval: string }[];
            }
        ).items.find((t) => t.name === 'browser.open')?.approval;
    expect(await toolInfo()).toBe('disabled');
    await shot(page, 'settings-browser-off');
    await enabled.click();
    await expect(enabled).toBeChecked();
    await expect.poll(toolInfo).toBe('required');
    await shot(page, 'settings-browser-on');
});
