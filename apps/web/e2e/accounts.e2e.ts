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
    // 每个账户的磁盘用量(ADR 0053 第 8 节)
    await expect(row).toContainText('附件 0 B,知识库 0 B');
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

test('管理员给成员分配文件夹;成员只看到分给自己的,看不到添加入口和只有管理员能开的设置(ADR 0053 第 4 节)', async ({
    page,
    browser,
}) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(base);
    await signIn(page, 'owner');
    await openAccounts(page);
    const section = page.getByRole('region', { name: '账户', exact: true });
    const invite = await oneTimeCode(page, '生成邀请码');
    await page.getByRole('button', { name: '关闭' }).click();

    const other = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const kim = await other.newPage();
    await kim.goto(base);
    await kim.getByRole('button', { name: '有邀请码' }).click();
    await kim.getByLabel('邀请码').fill(invite);
    await kim.getByLabel('用户名').fill('kim');
    await kim.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await kim.getByRole('button', { name: '创建账户并登录' }).click();
    await expect(kim.getByRole('link', { name: '设置', exact: true })).toBeVisible();

    // 管理员在账户列表里给 kim 分配一个文件夹
    await page.reload();
    const row = section.locator('[data-account="kim"]');
    await row.getByRole('button', { name: '分配文件夹' }).click();
    const folders = page.getByTestId('account-folders-kim');
    await expect(folders).toContainText('还没有分给这个账户的文件夹');
    await folders.getByLabel('文件夹路径').fill(dir);
    await folders.getByRole('button', { name: '分配', exact: true }).click();
    await expect(folders.locator('[data-fs-root]')).toHaveCount(1);
    await shot(section, 'accounts-assign-folder');

    // 成员:看到分给自己的文件夹,没有「授权」输入框和「撤销」按钮
    await kim.getByRole('link', { name: '设置', exact: true }).click();
    await kim.getByRole('tab', { name: /工作台/ }).click();
    await kim.getByRole('button', { name: '文件夹', exact: true }).click();
    await expect(kim.locator('[data-fs-root]')).toHaveCount(1);
    await expect(kim.getByText('这些文件夹由管理员分配给你')).toBeVisible();
    await expect(kim.getByRole('button', { name: '授权', exact: true })).toHaveCount(0);
    await expect(kim.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);
    await shot(kim, 'member-folders');

    // 成员:MCP 和代码只显示一句说明
    await kim.getByRole('tab', { name: /工具插件/ }).click();
    await kim.getByRole('button', { name: 'MCP 服务器', exact: true }).click();
    const mcp = kim.locator('#settings-tools-mcp');
    await expect(mcp.getByTestId('admin-only')).toBeVisible();
    await expect(mcp.getByRole('button', { name: '添加', exact: true })).toHaveCount(0);
    await kim.getByRole('button', { name: '代码', exact: true }).click();
    const code = kim.getByRole('region', { name: '编码项目' });
    await expect(code.getByTestId('admin-only')).toBeVisible();
    await expect(code.getByRole('checkbox')).toHaveCount(0);
    await shot(kim, 'member-code');

    // 收回之后成员就看不到了
    page.once('dialog', (d) => void d.accept());
    await folders.locator('[data-fs-root]').getByRole('button', { name: '撤销' }).click();
    await expect(folders).toContainText('还没有分给这个账户的文件夹');
    expect(((await (await other.request.get(`${base}/api/v1/fs/roots`)).json()) as { items: unknown[] }).items).toEqual(
        [],
    );
    await other.close();
});

test('成员保存自己的密钥;管理员共享的配置档成员能看到但不能改(ADR 0053 第 5 节)', async ({ page, browser }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(base);
    await signIn(page, 'owner');
    await openAccounts(page);
    const invite = await oneTimeCode(page, '生成邀请码');
    await page.getByRole('button', { name: '关闭' }).click();

    // 管理员建一个共享给成员的配置档
    await page.getByRole('tab', { name: /模型与语音/ }).click();
    await page.getByRole('button', { name: '概览与模型', exact: true }).click();
    const models = page.locator('#model-profiles');
    await models.getByRole('button', { name: '添加配置档' }).click();
    const form = page.getByRole('form', { name: 'model-profile' });
    await form.getByLabel('名称').fill('Family chat');
    await form.getByLabel('接口地址').fill('https://llm.example.test/v1');
    await form.getByLabel('模型', { exact: true }).fill('family-model');
    await form.getByLabel('密钥引用').fill('file:FAMILY_KEY');
    await form.getByLabel('共享给成员').check();
    await form.getByRole('button', { name: '保存' }).click();
    await expect(models.locator('[data-profile="Family chat"]').getByTestId('shared-badge')).toBeVisible();
    await shot(models, 'admin-shared-profile');

    const other = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const kim = await other.newPage();
    await kim.goto(base);
    await kim.getByRole('button', { name: '有邀请码' }).click();
    await kim.getByLabel('邀请码').fill(invite);
    await kim.getByLabel('用户名').fill('kai');
    await kim.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await kim.getByRole('button', { name: '创建账户并登录' }).click();
    await expect(kim.getByRole('link', { name: '设置', exact: true })).toBeVisible();

    // 成员:共享来的配置档只读,不显示地址和密钥引用
    await kim.getByRole('link', { name: '设置', exact: true }).click();
    await kim.getByRole('tab', { name: /模型与语音/ }).click();
    await kim.getByRole('button', { name: '概览与模型', exact: true }).click();
    const card = kim.locator('#model-profiles [data-profile="Family chat"]');
    await expect(card.getByTestId('shared-by-admin')).toBeVisible();
    await expect(card).not.toContainText('llm.example.test');
    await expect(card).not.toContainText('FAMILY_KEY');
    await expect(card.getByRole('button')).toHaveCount(0);
    await shot(kim.locator('#model-profiles'), 'member-shared-profile');

    // 成员:在「密钥」里保存自己的键,看到的是不带前缀的名字和带前缀的引用
    await kim.getByRole('tab', { name: /系统设置/ }).click();
    await kim.getByRole('button', { name: '密钥', exact: true }).click();
    const keys = kim.getByRole('region', { name: '我的密钥' });
    await keys.getByLabel('键名').fill('OPENAI_API_KEY');
    await keys.getByLabel('值', { exact: true }).fill('sk-kai-123456');
    await keys.getByRole('button', { name: '保存密钥' }).click();
    const row = keys.locator('[data-key="OPENAI_API_KEY"]');
    await expect(row).toContainText(/file:U[0-9A-Z]{26}_OPENAI_API_KEY/);
    await expect(keys).not.toContainText('sk-kai-123456');
    await expect(kim.getByTestId('admin-only')).toBeVisible();
    await shot(kim, 'member-secret-keys');

    // 管理员看不到成员的键
    await page.getByRole('tab', { name: /系统设置/ }).click();
    await page.getByRole('button', { name: '密钥', exact: true }).click();
    await expect(page.getByRole('region', { name: '我的密钥' })).toContainText('还没有保存密钥');
    await other.close();
});
