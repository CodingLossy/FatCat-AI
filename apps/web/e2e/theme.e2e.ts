// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 主题引擎(M12):新安装是科技主题;旧设置值按科技显示且不改写;设置页的主题选择是单选组。
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-theme-e2e-'));
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
    await page.waitForTimeout(600);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test('科技为默认主题,旧值 light 按科技显示且不改写,主题选择可用键盘', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();

    await expect(page.getByTestId('voice-indicator')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'tech');
    await shot(page, 'idle');

    await page.getByRole('button', { name: '文件', exact: true }).click();
    await expect(page.locator('.wb-float')).toBeVisible();
    await shot(page, 'working');
    await page.keyboard.press('Escape');

    // 旧设置值:服务器照存照返,界面按科技显示
    const put = await page.evaluate(async () => {
        const r = await fetch('/api/v1/settings', {
            method: 'PUT',
            headers: {
                'content-type': 'application/json',
                'x-csrf-token': /(?:^|; )aip_csrf=([^;]*)/.exec(document.cookie)?.[1] ?? '',
            },
            body: JSON.stringify({ theme: 'light' }),
        });
        return ((await r.json()) as { theme: string }).theme;
    });
    expect(put).toBe('light');
    await page.goto(`${base}/settings`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'tech');
    await page.getByRole('tab', { name: /工作台/ }).click();
    const tech = page.getByRole('radio', { name: /科技/ });
    await expect(tech).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: /自然/ })).toBeDisabled();
    const stored = await page.evaluate(
        async () => ((await (await fetch('/api/v1/settings')).json()) as { theme: string }).theme,
    );
    expect(stored).toBe('light');
    await tech.click();
    await expect
        .poll(async () =>
            page.evaluate(async () => ((await (await fetch('/api/v1/settings')).json()) as { theme: string }).theme),
        )
        .toBe('tech');
    await shot(page, 'settings');

    await page.goto(`${base}/items`);
    await shot(page, 'knowledge');
    await page.goto(`${base}/mail`);
    await shot(page, 'mail');

    await page.setViewportSize({ width: 390, height: 820 });
    await page.goto(base);
    await expect(page.getByTestId('voice-indicator')).toBeVisible();
    await shot(page, 'narrow');
});
