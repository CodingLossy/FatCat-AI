// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 布局与登录页:桌面宽度下侧边栏始终满高、不随右侧内容滚动;登录页在亮 / 暗色与窄屏下可用。
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-layout-e2e-'));
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

const TAG = process.env.FATCAT_SHOT_TAG ?? 'after';

async function shot(page: import('@playwright/test').Page, name: string) {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-${TAG}.png`) });
}

test('登录页:亮 / 暗色与窄屏', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(base);
    await expect(page.getByLabel('设置码', { exact: false })).toBeVisible();
    await expect(page.getByText('启动日志里的一次性设置码')).toBeVisible();
    await shot(page, 'auth-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'auth-dark');
    await page.setViewportSize({ width: 360, height: 640 });
    await shot(page, 'auth-narrow');

    // 密码显示切换
    const password = page.getByLabel('密码', { exact: true });
    await password.fill(PASSWORD);
    await expect(password).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: '显示' }).click();
    await expect(password).toHaveAttribute('type', 'text');
});

test('桌面宽度:滚动右侧内容时侧边栏高度等于视口且不动', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 640 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();
    await page.getByRole('link', { name: '设置', exact: true }).click();
    // 宽屏的页面在工作台里:侧栏是 .wb-side,页面内容在 .wb-page 里滚动
    await expect(page.locator('.wb-page')).toBeVisible();

    const metrics = () =>
        page.evaluate(() => {
            const side = document.querySelector('.wb-side')!.getBoundingClientRect();
            const content = document.querySelector('.wb-page') as HTMLElement;
            return {
                sideTop: Math.round(side.top),
                sideHeight: Math.round(side.height),
                viewport: window.innerHeight,
                footerTop: Math.round(document.querySelector('.footer')!.getBoundingClientRect().top),
                footerHeight: Math.round(document.querySelector('.footer')!.getBoundingClientRect().height),
                pageScroll: document.documentElement.scrollHeight,
                contentScrollable: content.scrollHeight > content.clientHeight,
            };
        });
    const before = await metrics();
    expect(before.contentScrollable, '设置页应比 640px 视口长').toBe(true);
    // 侧边栏占满页脚以上的全部高度(页脚固定在视口底部)
    expect(before.sideTop + before.sideHeight).toBe(before.footerTop);
    expect(before.footerTop + before.footerHeight).toBe(before.viewport);
    await shot(page, 'settings-top');
    await page.locator('.wb-page').evaluate((el) => (el.scrollTop = el.scrollHeight));
    const after = await metrics();
    expect(after.sideTop).toBe(0);
    expect(after.sideHeight).toBe(before.sideHeight);
    expect(after.pageScroll).toBeLessThanOrEqual(after.viewport);
    await shot(page, 'settings-bottom');
});
