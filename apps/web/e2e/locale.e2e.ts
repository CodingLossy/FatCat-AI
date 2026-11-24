// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语言切换冒烟(ADR 0043):在设置里切到 English 后,逐页检查可见文字里没有中文残留(语言选择器里的「中文」除外),
// 刷新后语言保持;再切回中文,没有英文固定文案的残留检查由 scripts/check-i18n.mjs 负责。
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-locale-e2e-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [SERVER_ENTRY], {
        env: {
            PATH: process.env.PATH,
            HOME: dir,
            USERPROFILE: dir,
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

test('switching to English leaves no Chinese text on any page', async ({ page }) => {
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();

    await page.getByRole('link', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: /工作台/ }).click();
    await page.getByRole('button', { name: '通用' }).click();
    await page.locator('select[name="locale"]').selectOption('en');
    await expect(page.getByRole('link', { name: 'New chat' })).toBeVisible();

    // 刷新后语言保持
    await page.reload();
    await expect(page.getByRole('link', { name: 'New chat' })).toBeVisible();

    const cjk = /[\u3400-\u9fff]/;
    for (const path of ['/', '/settings', '/memory', '/tasks', '/agents', '/plugins', '/items', '/mail', '/audit']) {
        await page.goto(`${base}${path}`);
        await expect(page.getByRole('link', { name: 'New chat' })).toBeVisible();
        await page.waitForLoadState('networkidle');
        // 预置角色的名字是第一次使用时按当时的语言写入数据库的(用户数据),不在检查范围内
        const visible = (
            await page.evaluate(() => {
                const clone = document.body.cloneNode(true) as HTMLElement;
                clone
                    .querySelectorAll('[data-testid="agent-card"], [data-testid="agent-picker"]')
                    .forEach((n) => n.remove());
                return clone.textContent ?? '';
            })
        ).replace('中文', '');
        expect(visible, `Chinese text left on ${path}`).not.toMatch(cjk);
        if (path === '/') {
            // 没有转写配置档时默认的语音模式退回输入框并给出提示(#130 X 审查):提示的英文也在检查范围内
            await expect(page.getByText('No speech recognition model yet')).toBeVisible();
        }
        if (SHOTS && (path === '/items' || path === '/settings')) {
            await page.screenshot({ path: join(SHOTS, `en${path.replace('/', '-')}.png`), fullPage: true });
        }
    }
});
