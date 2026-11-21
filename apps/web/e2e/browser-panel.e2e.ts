// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 浏览器面板(M12 PR 7):在没有真实桌面壳的环境里,用假的 `__TAURI_INTERNALS__` 验证界面一侧——
// 地址栏把地址和占位元素的位置交给壳、壳发来的拦截事件显示成提示、向服务器声明浏览器能力。
// 壳本身(原生 webview、隔离、拦截)只能在 Windows / macOS 真机上验证,见 PR 描述的清单。
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-browser-panel-e2e-'));
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

/** 假的桌面壳:记录每次 invoke,按命令名回答。 */
const FAKE_SHELL = `
window.__calls = [];
window.__TAURI_INTERNALS__ = {
    invoke(cmd, args) {
        window.__calls.push({ cmd, args });
        if (cmd === 'browser_open' || cmd === 'browser_navigate') {
            const url = String(args.url);
            return Promise.resolve(/^https?:/.test(url) ? url : 'https://' + url + '/');
        }
        if (cmd === 'browser_navigate') return Promise.resolve(String(args.url));
        return Promise.resolve(null);
    },
};
`;

test('桌面壳里的浏览器面板:地址交给壳、拦截提示、声明浏览器能力', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    const sent: string[] = [];
    page.on('websocket', (ws) => ws.on('framesent', (frame) => sent.push(String(frame.payload))));
    await page.addInitScript(FAKE_SHELL);
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();

    // 在壳里登录后,界面向服务器声明 browser 能力(之后才会收到 client-call 帧)
    await expect
        .poll(() => sent.some((frame) => frame.includes('"client-capabilities"') && frame.includes('"browser":true')))
        .toBe(true);

    await page.getByRole('button', { name: '浏览器', exact: true }).click();
    const address = page.getByLabel('地址栏(点击输入新地址)');
    await expect(address).toBeVisible();
    await expect(page.getByText('输入网址即可浏览')).toBeVisible();
    await expect(page.getByText('子资源')).toBeVisible();
    await shot(page, 'browser-panel-idle');

    await address.fill('example.com');
    await address.press('Enter');
    const calls = () =>
        page.evaluate(
            () =>
                (
                    window as unknown as {
                        __calls: { cmd: string; args: { url: string; bounds: { width: number; height: number } } }[];
                    }
                ).__calls,
        );
    await expect.poll(async () => (await calls()).some((c) => c.cmd === 'browser_open')).toBe(true);
    const open = (await calls()).find((c) => c.cmd === 'browser_open')!;
    expect(open.args.url).toBe('example.com');
    expect(open.args.bounds.width).toBeGreaterThan(100);
    expect(open.args.bounds.height).toBeGreaterThan(100);

    // 壳发来页面事件:地址栏显示主机(不显示路径与查询串),被拦截的跳转显示提示
    await page.evaluate(() => {
        window.dispatchEvent(
            new CustomEvent('fatcat-browser', {
                detail: { type: 'loaded', url: 'https://example.com/a?token=secret' },
            }),
        );
        window.dispatchEvent(
            new CustomEvent('fatcat-browser', {
                detail: { type: 'blocked', what: 'navigation', reason: 'ip_literal', origin: 'https://127.0.0.1' },
            }),
        );
    });
    await expect(page.locator('.wb-browser-url')).toContainText('example.com');
    await expect(page.locator('.wb-browser-url')).not.toContainText('token');
    await expect(page.getByRole('status').filter({ hasText: '已拦截跳转到 https://127.0.0.1' })).toContainText(
        '不允许直接用 IP 地址',
    );
    await shot(page, 'browser-panel-loaded-blocked');

    // 工具栏:后退 / 刷新转给壳;关闭面板回到空状态
    await page.getByRole('button', { name: '后退' }).click();
    await page.getByRole('button', { name: '刷新' }).click();
    await page.getByRole('button', { name: '关闭浏览器' }).click();
    await expect(page.getByText('输入网址即可浏览')).toBeVisible();
    const names = (await calls()).map((c) => c.cmd);
    expect(names).toEqual(expect.arrayContaining(['browser_back', 'browser_reload', 'browser_close']));
});

test('不在桌面壳里:不声明浏览器能力,浏览器面板仍是文字卡片', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    const sent: string[] = [];
    page.on('websocket', (ws) => ws.on('framesent', (frame) => sent.push(String(frame.payload))));
    await page.goto(base);
    // 上一个用例已经创建了账户:这里走登录
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '浏览器', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '浏览器', exact: true }).click();
    await expect(page.getByText('内置浏览器在桌面版提供')).toBeVisible();
    expect(sent.some((frame) => frame.includes('client-capabilities'))).toBe(false);
    await shot(page, 'browser-panel-web-fallback');
});
