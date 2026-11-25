// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// QQ 渠道(ADR 0052 第 5 节):设置 → 渠道里新建 QQ 渠道、填写 AppID 与 AppSecret;AppSecret 提交后不回显、
// 不出现在接口响应里。渠道保持停用,不连真实的 QQ 开放平台。截图用 FATCAT_SHOTS_DIR / FATCAT_SHOTS_THEME。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = join(here, '../../server/dist/index.js');
const WEB_DIST = join(here, '../dist');
const PASSWORD = 'correct horse battery staple';
const SHOTS = process.env.FATCAT_SHOTS_DIR;
const THEME = process.env.FATCAT_SHOTS_THEME;

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
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'fatcat-qq-e2e-')));
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

async function api(
    page: Page,
    method: string,
    path: string,
    body?: unknown,
): Promise<{ status: number; json: unknown }> {
    return page.evaluate(
        async ({ method, path, body }) => {
            const csrf = /(?:^|; )aip_csrf=([^;]*)/.exec(document.cookie)?.[1] ?? '';
            const res = await fetch(path, {
                method,
                headers: { 'content-type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: res.status, json: res.status === 204 ? null : await res.json() };
        },
        { method, path, body },
    );
}

/** 页面在主区域里滚动,截图前先把要看的部分滚进视口。 */
async function shot(page: Page, name: string, target?: Locator) {
    if (!SHOTS) return;
    if (target) {
        await target.evaluate((el) => {
            el.scrollIntoView({ block: 'start' });
            // 顶部有浮动的标题栏:再往回滚一点,别把标题压住
            let box = el.parentElement;
            while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
            box?.scrollBy(0, -96);
        });
    }
    await page.screenshot({ path: join(SHOTS, `${THEME ?? 'tech'}-${name}.png`) });
}

async function openChannels(page: Page) {
    await page.goto(`${base}/settings`);
    await page.getByRole('tab', { name: /工作台/ }).click();
    const item = page.getByRole('button', { name: '渠道', exact: true });
    if (await item.isVisible()) await item.click();
}

test('QQ 渠道:新建、填写凭据(AppSecret 不回显)、手机布局', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();
    if (THEME) {
        expect((await api(page, 'PUT', '/api/v1/settings', { theme: THEME })).status).toBe(200);
        await page.reload();
    }

    await openChannels(page);
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: '渠道', exact: true }) });
    await section.getByLabel('类型').selectOption('qq');
    await section.getByLabel('名称', { exact: true }).fill('QQ 机器人');
    await section.getByRole('button', { name: '添加', exact: true }).click();
    const card = section.locator('[data-channel]').filter({ hasText: 'QQ 机器人' });
    await expect(card).toContainText('QQ');
    await expect(card).toContainText('还没有填写凭据');

    // 渠道保持停用:不连真实的 QQ 开放平台
    await card.getByRole('button', { name: 'QQ 机器人凭据' }).click();
    await card.getByLabel('AppID').fill('102030');
    await card.getByLabel('AppSecret').fill('e2e-app-secret-value');
    await shot(page, 'qq-credentials-form', card);
    await card.getByRole('button', { name: '保存凭据' }).click();
    await expect(card.locator('[data-qq-app-id]')).toHaveText('已保存 AppID 102030');
    await expect(card.getByLabel('AppSecret')).toHaveCount(0);
    expect(await page.content()).not.toContain('e2e-app-secret-value');
    const list = await api(page, 'GET', '/api/v1/channels');
    expect(JSON.stringify(list.json)).not.toContain('e2e-app-secret-value');
    expect(JSON.stringify(list.json)).toContain('"appId":"102030"');
    await shot(page, 'qq-credentials-saved', card);

    // 再次打开:AppID 预填,AppSecret 是空的
    await card.getByRole('button', { name: 'QQ 机器人凭据' }).click();
    await expect(card.getByLabel('AppID')).toHaveValue('102030');
    await expect(card.getByLabel('AppSecret')).toHaveValue('');

    // 手机:重新打开页面(侧栏按窄屏收起),再展开表单
    await page.setViewportSize({ width: 390, height: 844 });
    await openChannels(page);
    await card.getByRole('button', { name: 'QQ 机器人凭据' }).click();
    await expect(card.getByLabel('AppSecret')).toBeVisible();
    const box = await card.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await shot(page, 'qq-credentials-mobile', card);
});
