// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设备配对(ADR 0045 第 1 节):设置页生成配对码、设备用配对码换令牌后出现在列表、改名与吊销立即生效。
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-devices-e2e-'));
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

test('添加设备:配对码、配对后出现在列表、改名、吊销', async ({ page, browser }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await page.getByRole('link', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: /系统设置/ }).click();
    await page.getByRole('button', { name: '账户与设备' }).click();
    const section = page.getByRole('region', { name: '已配对设备' });
    await expect(section).toBeVisible();
    await expect(section.getByText('还没有配对的设备')).toBeVisible();

    await section.getByRole('button', { name: '添加设备' }).click();
    const pairing = page.getByTestId('pairing-code');
    await expect(pairing).toBeVisible();
    const code = (await pairing.locator('.pairing-code').innerText()).trim();
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    await shot(page, 'devices-pairing');

    // 另一个没有登录的浏览器上下文(模拟手机)用配对码换令牌
    const phone = await browser.newContext();
    const res = await phone.request.post(`${base}/api/v1/devices/pair`, { data: { code, name: '我的手机' } });
    expect(res.status()).toBe(201);
    const tokens = (await res.json()) as { accessToken: string };
    expect(
        (
            await phone.request.get(`${base}/api/v1/auth/me`, {
                headers: { Authorization: `Bearer ${tokens.accessToken}` },
            })
        ).ok(),
    ).toBe(true);
    // 配对码只能用一次
    expect((await phone.request.post(`${base}/api/v1/devices/pair`, { data: { code, name: 'again' } })).status()).toBe(
        401,
    );

    // 回到设置页:配对码已用掉,刷新后设备在列表里
    await page.reload();
    const list = page.getByRole('region', { name: '已配对设备' });
    await expect(list.getByText('我的手机')).toBeVisible();
    await shot(page, 'devices-list');

    await list.getByRole('button', { name: '改名' }).click();
    await list.getByLabel('设备名称').fill('Pixel');
    await list.getByRole('button', { name: '保存' }).click();
    await expect(list.getByText('Pixel')).toBeVisible();

    await list.getByRole('button', { name: '吊销' }).click();
    await list.getByRole('button', { name: '确认吊销' }).click();
    await expect(list.getByText('还没有配对的设备')).toBeVisible();
    // 吊销立即生效
    expect(
        (
            await phone.request.get(`${base}/api/v1/auth/me`, {
                headers: { Authorization: `Bearer ${tokens.accessToken}` },
            })
        ).status(),
    ).toBe(401);
    await phone.close();
});

test('手机视口:配对码与设备列表不横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('link', { name: '设置', exact: true }).click();
    // 窄屏只显示分类;分区内的分组单列排开,不用再点子项
    await page.getByRole('tab', { name: /系统设置/ }).click();
    const section = page.getByRole('region', { name: '已配对设备' });
    await section.getByRole('button', { name: '添加设备' }).click();
    await expect(page.getByTestId('pairing-code')).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'devices-mobile');
});

test('手机配对页:用链接里的配对码配对后以设备令牌登录,吊销后回到登录页', async ({ page, browser }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByRole('link', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: /系统设置/ }).click();
    await page.getByRole('button', { name: '账户与设备' }).click();
    const section = page.getByRole('region', { name: '已配对设备' });
    await section.getByRole('button', { name: '添加设备' }).click();
    const code = (await page.getByTestId('pairing-code').locator('.pairing-code').innerText()).trim();

    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    const p = await phone.newPage();
    await p.goto(`${base}/pair?code=${code}`);
    // 配对码立即从地址栏去掉,并预填到表单
    await expect(p).toHaveURL(`${base}/pair`);
    await expect(p.getByLabel('配对码')).toHaveValue(code);
    await p.getByLabel('设备名称').fill('E2E 手机');
    await shot(p, 'pair-page-mobile');
    await p.getByRole('button', { name: '配对设备' }).click();

    // 整页跳到首页,已用设备令牌登录(没有 Cookie 会话)
    await expect(p.getByRole('button', { name: '菜单' })).toBeVisible();
    expect((await phone.cookies()).some((c) => c.name === 'aip_session')).toBe(false);
    await shot(p, 'pair-home-mobile');

    // 电脑上设备列表里能看到,吊销后手机下一次请求就回到登录页
    await page.reload();
    const list = page.getByRole('region', { name: '已配对设备' });
    await expect(list.getByText('E2E 手机')).toBeVisible();
    await list.getByRole('button', { name: '吊销' }).click();
    await list.getByRole('button', { name: '确认吊销' }).click();
    await p.reload();
    await expect(p.getByLabel('用户名')).toBeVisible();
    await phone.close();
});
