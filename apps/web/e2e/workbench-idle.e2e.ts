// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 工作台空闲布局(M12):空闲不显示面板;侧栏两态并记住;Ctrl+K 命令和 Esc 收起面板。
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-workbench-idle-e2e-'));
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
    await page.waitForTimeout(400);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test('空闲没有面板;打开后 Esc 与命令都能收起;侧栏 Ctrl+B 两态并记住', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();

    const panel = page.locator('.wb-float');
    await expect(page.getByTestId('voice-indicator')).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /搜索文件/ })).toHaveCount(0);
    // 没有工具在跑就不显示工具卡片;空对话只有一行状态文字
    await expect(page.locator('.wb-running')).toHaveCount(0);
    await expect(page.getByTestId('voice-indicator')).toHaveText('开始一段新对话吧。');
    await expect(page.getByTestId('messages').locator('.empty')).toHaveCount(0);
    await shot(page, 'workbench-idle');

    await page.getByRole('button', { name: '文件', exact: true }).click();
    await expect(panel).toBeVisible();
    await shot(page, 'workbench-panel-open');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    await page.getByRole('button', { name: '邮件', exact: true }).click();
    await expect(panel).toBeVisible();
    await page.keyboard.press('Control+k');
    const search = page.getByRole('combobox', { name: /搜索文件/ });
    await expect(search).toBeFocused();
    await search.fill('收起');
    await page.getByRole('option', { name: '收起面板' }).click();
    await expect(panel).toHaveCount(0);

    const shell = page.locator('.wb-shell');
    await expect(shell).toHaveAttribute('data-sidebar', 'full');
    await page.keyboard.press('Control+b');
    await expect(shell).toHaveAttribute('data-sidebar', 'min');
    await shot(page, 'workbench-sidebar-collapsed');
    await page.reload();
    await expect(page.locator('.wb-shell')).toHaveAttribute('data-sidebar', 'min');
    await page.getByRole('button', { name: '展开侧栏' }).click();
    await expect(page.locator('.wb-shell')).toHaveAttribute('data-sidebar', 'full');
});
