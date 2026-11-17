// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 手机视口冒烟(M5c 方案 PR 3):同样启动构建后的 server 与回放 fixture 的假端点,在手机宽度下完成
// 登录 → 发一条消息 → 设置 → 邮件 → 记忆 → 审计,并断言每一页在 360 / 390 / 430 宽度与横屏下没有横向滚动。
// 知识地图的下钻在 items.e2e.ts 的手机用例里。设置环境变量 FATCAT_SHOTS_DIR 时会顺便截图。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Interaction, loadFixture } from '@fatcat-ai/eval';
import { expect, type Page, test } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = join(here, '../../server/dist/index.js');
const WEB_DIST = join(here, '../dist');
const FIXTURES = join(here, '../../../packages/providers/test/fixtures');
const PASSWORD = 'correct horse battery staple';
/** 明显是假的密钥,只用来让 keyStatus 显示为「已设置」;假端点不校验它。 */
const SHOTS = process.env.FATCAT_SHOTS_DIR;
const FAKE_KEY = 'sk-test-THIS-IS-NOT-A-REAL-KEY-0123456789';

let dir = '';
let server: ChildProcess | undefined;
let mock: Server | undefined;
let base = '';
let mockBase = '';
const queue: { interaction: Interaction; delayMs: number }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 按顺序回放排队的交互,每个分块之间等待 delayMs,好在流式途中刷新页面。 */
function startMock(): Promise<Server> {
    const s = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            void (async () => {
                const next = queue.shift();
                if (!next || req.url !== next.interaction.request.path) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
                    return;
                }
                const { response } = next.interaction;
                res.writeHead(response.status, response.headers);
                for (const chunk of response.chunks) {
                    res.write(chunk);
                    if (next.delayMs) await sleep(next.delayMs);
                }
                res.end();
            })();
        });
    });
    return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s)));
}

const enqueue = (name: string, delayMs = 0) => {
    for (const interaction of loadFixture(join(FIXTURES, `${name}.json`)).interactions) {
        queue.push({ interaction, delayMs });
    }
};

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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-web-mobile-e2e-'));
    mock = await startMock();
    mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`;
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
            DEEPSEEK_API_KEY: FAKE_KEY,
        },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    for (let i = 0; i < 100; i++) {
        const ok = await fetch(`${base}/healthz`).then(
            (r) => r.ok,
            () => false,
        );
        if (ok) return;
        await sleep(100);
    }
    throw new Error('server did not become healthy');
});

test.afterAll(async () => {
    if (server && server.exitCode === null) {
        const exited = new Promise((r) => server!.once('exit', r));
        server.kill();
        await exited;
    }
    await new Promise<void>((r) => (mock ? mock.close(() => r()) : r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
});

test.describe.configure({ mode: 'serial' });

const VIEWPORTS = [
    { name: '360', width: 360, height: 740 },
    { name: '390', width: 390, height: 844 },
    { name: '430', width: 430, height: 932 },
    { name: 'landscape', width: 844, height: 390 },
];

async function noHorizontalScroll(page: Page, where: string): Promise<void> {
    const over = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
    }));
    expect(over.scroll, `${where}: 页面不应横向滚动`).toBeLessThanOrEqual(over.client);
}

async function shot(page: Page, name: string): Promise<void> {
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    if (SHOTS) await page.waitForTimeout(300); // 等抽屉动画结束
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** 手机宽度下导航在抽屉里:先点「菜单」再点链接。 */
async function goto(page: Page, link: string): Promise<void> {
    await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('link', { name: link, exact: true })).toBeHidden();
}

test('手机宽度:登录、发消息、设置、邮件、记忆、审计,各宽度无横向滚动', async ({ browser }) => {
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
        locale: 'zh-CN',
    });
    const page = await ctx.newPage();
    page.on('dialog', (d) => void d.accept());

    await page.goto(base);
    await expect(page.getByRole('heading', { name: '创建主人账户' })).toBeVisible();
    await noHorizontalScroll(page, '初始化');
    await shot(page, 'auth');
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('button', { name: '菜单' })).toBeVisible();

    // 抽屉默认收起;打开后能看到链接,Esc 关闭
    await expect(page.getByRole('link', { name: '新对话' })).toBeHidden();
    await page.getByRole('button', { name: '菜单' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();
    await expect(page.getByRole('link', { name: '新对话' })).toBeFocused();
    await shot(page, 'drawer');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('link', { name: '新对话' })).toBeHidden();
    await expect(page.getByRole('button', { name: '菜单' })).toBeFocused();
    // 点指向当前页的链接(已经在首页,「新对话」就是当前页)也要关闭抽屉
    await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('link', { name: '新对话' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeHidden();

    // 配置档
    await goto(page, '设置');
    await page.getByRole('button', { name: '添加配置档' }).click();
    const form = page.getByRole('form', { name: 'model-profile' });
    await form.getByLabel('名称').fill('DeepSeek');
    await form.getByLabel('接口地址').fill(mockBase);
    await form.getByLabel('模型').fill('deepseek-chat');
    await form.getByLabel('密钥引用').fill('env:DEEPSEEK_API_KEY');
    await form.getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('key-status')).toHaveText('密钥: 已设置');
    await noHorizontalScroll(page, '设置');
    await shot(page, 'settings');

    // 发一条消息
    await goto(page, '新对话');
    enqueue('deepseek-chat-stream');
    const composer = page.getByRole('textbox', { name: /输入消息/ });
    await composer.fill('请只回复四个字:你好世界');
    await composer.press('Enter');
    await expect(page.locator('.message.assistant[data-status="complete"]')).toHaveText('你好世界', {
        timeout: 15_000,
    });
    await noHorizontalScroll(page, '聊天');
    await expect(composer).toBeInViewport();
    await shot(page, 'chat');

    // 其余页面:每个宽度各检查一遍
    for (const link of ['记忆', '审计', '邮件', '设置', '知识地图']) {
        await goto(page, link);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        for (const vp of VIEWPORTS) {
            await page.setViewportSize({ width: vp.width, height: vp.height });
            await noHorizontalScroll(page, `${link} @ ${vp.name}`);
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await shot(page, `page-${link}`);
    }
    await goto(page, '新对话');
    for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await noHorizontalScroll(page, `聊天 @ ${vp.name}`);
    }
    await ctx.close();
});
