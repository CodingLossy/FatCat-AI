// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 账户管理(ADR 0053 第 2 节):管理员生成邀请码,对方在登录页用它建账户;停用后登录失败,重置码设新密码,删除要输入用户名。
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-accounts-e2e-'));
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

async function shot(target: import('@playwright/test').Page | import('@playwright/test').Locator, name: string) {
    if (SHOTS) await target.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function signIn(page: import('@playwright/test').Page, username: string, password = PASSWORD) {
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
}

async function openAccounts(page: import('@playwright/test').Page) {
    await page.getByRole('link', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: /系统设置/ }).click();
    await page.getByRole('button', { name: '账户与设备' }).click();
}

async function oneTimeCode(page: import('@playwright/test').Page, button: RegExp | string) {
    const section = page.getByRole('region', { name: '账户', exact: true });
    await section.getByRole('button', { name: button }).first().click();
    const box = page.getByTestId('account-code');
    await expect(box).toBeVisible();
    const code = (await box.locator('.pairing-code').innerText()).trim();
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    return code;
}

test('邀请成员、停用与启用、重置密码、删除', async ({ page, browser }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await openAccounts(page);
    const section = page.getByRole('region', { name: '账户', exact: true });
    await expect(section.locator('[data-account="owner"]')).toContainText('管理员');
    const invite = await oneTimeCode(page, '生成邀请码');
    await shot(section, 'accounts-invite-code');
    await page.getByRole('button', { name: '关闭' }).click();

    // 另一个浏览器(成员)在登录页用邀请码加入
    const other = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const kid = await other.newPage();
    await kid.goto(base);
    await kid.getByRole('button', { name: '有邀请码' }).click();
    await kid.getByLabel('邀请码').fill(invite.toLowerCase());
    await kid.getByLabel('用户名').fill('kid');
    await kid.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await shot(kid, 'accounts-accept-invite');
    await kid.getByRole('button', { name: '创建账户并登录' }).click();
    await openAccounts(kid);
    await expect(kid.getByRole('region', { name: '已配对设备' })).toBeVisible();
    await expect(kid.getByRole('region', { name: '账户', exact: true })).toHaveCount(0); // 成员看不到

    await page.reload();
    const row = section.locator('[data-account="kid"]');
    await expect(row).toContainText('成员');
    await shot(section, 'accounts-list');

    // 停用:成员的会话立即失效
    await row.getByRole('button', { name: '停用' }).click();
    await expect(row).toContainText('已停用');
    expect((await other.request.get(`${base}/api/v1/auth/me`)).status()).toBe(401);
    await row.getByRole('button', { name: '启用' }).click();
    await expect(row).not.toContainText('已停用');

    // 重置码:成员设新密码后用新密码登录
    const reset = await oneTimeCode(page, '生成重置码');
    await page.getByRole('button', { name: '关闭' }).click();
    await kid.goto(base);
    await kid.getByRole('button', { name: '有重置码' }).click();
    await kid.getByLabel('重置码').fill(reset);
    await kid.getByLabel('新密码').fill('another long password 42');
    await kid.getByRole('button', { name: '设新密码' }).click();
    await expect(kid.getByText('密码已重设')).toBeVisible();
    await signIn(kid, 'kid', 'another long password 42');
    await expect(kid.getByRole('link', { name: '设置', exact: true })).toBeVisible();

    // 删除:输入用户名才能确认
    await row.getByRole('button', { name: '删除' }).click();
    const confirm = row.getByRole('button', { name: '永久删除' });
    await expect(confirm).toBeDisabled();
    await row.locator('input[name="confirmUsername"]').fill('kid');
    await shot(section, 'accounts-delete-confirm');
    await confirm.click();
    await expect(section.locator('[data-account="kid"]')).toHaveCount(0);
    expect((await other.request.get(`${base}/api/v1/auth/me`)).status()).toBe(401);
    await other.close();
});
