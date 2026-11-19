// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 离线只读缓存(ADR 0045 第 2 节):联网时 /sync 追平 IndexedDB,断网重开页面仍能看到会话,登出后缓存清空。
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-offline-e2e-'));
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

async function cachedCount(page: import('@playwright/test').Page): Promise<number> {
    return page.evaluate(
        () =>
            new Promise<number>((resolve) => {
                const req = indexedDB.open('fatcat-cache');
                req.onerror = () => resolve(-1);
                req.onsuccess = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('sessions')) return resolve(0);
                    const count = db.transaction('sessions').objectStore('sessions').count();
                    count.onsuccess = () => resolve(count.result);
                    count.onerror = () => resolve(-1);
                };
                req.onupgradeneeded = () => resolve(0);
            }),
    );
}

test('联网时缓存会话;断网重开页面仍能看到并打开它们;登出后缓存清空', async ({ page, context }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    // 用 API 建两个会话,刷新后列表出现,后台同步写入 IndexedDB
    const csrf = (await context.cookies()).find((c) => c.name === 'aip_csrf')!.value;
    for (const title of ['离线会话甲', '离线会话乙']) {
        const res = await page.request.post(`${base}/api/v1/sessions`, {
            data: { title },
            headers: { 'x-csrf-token': csrf },
        });
        expect(res.ok()).toBe(true);
    }
    await page.reload();
    await expect(page.getByText('离线会话甲')).toBeVisible();
    await expect.poll(() => cachedCount(page)).toBe(2);

    // 断网后重新打开:界面显示缓存的会话和离线提示
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText('当前离线')).toBeVisible();
    await expect(page.getByText('离线会话甲')).toBeVisible();
    await expect(page.getByText('离线会话乙')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'offline-cache.png') });

    // 恢复联网:提示消失,仍是登录状态
    await context.setOffline(false);
    await expect(page.getByText('当前离线')).toBeHidden();
    await expect(page.getByText('离线会话甲')).toBeVisible();

    // 登出后缓存清空
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByLabel('用户名')).toBeVisible();
    await expect.poll(() => cachedCount(page)).toBe(0);
});
