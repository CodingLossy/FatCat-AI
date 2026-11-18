// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// PWA 外壳(ADR 0045 第 4 节):service worker 生效、离线时仍能打开界面、缓存里没有任何 /api 响应。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@fatcat-ai/storage';
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-pwa-e2e-'));
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

test('service worker 缓存应用壳,离线可打开,缓存里没有 API 响应', async ({ page, context }) => {
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();

    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    // 等 worker 接管当前页面,之后的请求才会经过它
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    await page.reload();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();

    const manifest = await page.request.get(`${base}/manifest.webmanifest`);
    expect(manifest.ok()).toBe(true);
    expect(manifest.headers()['cache-control']).toBe('no-cache');
    expect((await manifest.json()).display).toBe('standalone');

    const cached = await page.evaluate(async () => {
        const urls: string[] = [];
        for (const name of await caches.keys()) {
            const cache = await caches.open(name);
            for (const req of await cache.keys()) urls.push(new URL(req.url).pathname);
        }
        return urls;
    });
    expect(cached).toContain('/');
    expect(cached.some((u) => u.startsWith('/api/'))).toBe(false);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText('当前离线')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'pwa-offline.png') });
    await context.setOffline(false);
});
