// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 分类浏览器冒烟(ADR 0029,M5b PR 8):从「邮件」「小说」「人物」三个顶层类别各下钻到最深条目并打开,
// 桌面与手机宽度各一遍。小说是真实的提供者数据(授权文件夹);邮件与人物用一个独立的 source 写入条目索引,
// 只验证浏览器本身(真实邮箱与联系人识别由服务端测试覆盖)。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepositories, openDatabase } from '@fatcat-ai/storage';
import { expect, type Page, test } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = join(here, '../../server/dist/index.js');
const WEB_DIST = join(here, '../dist');
const PASSWORD = 'correct horse battery staple';
const SHOTS = process.env.FATCAT_SHOTS_DIR;

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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-items-e2e-'));
    const books = realpathSync.native(mkdirSync(join(dir, 'Books'), { recursive: true }) ?? join(dir, 'Books'));
    writeFileSync(
        join(books, '凡人.txt'),
        ['第一章 山村少年', '他出生在一个小山村。', '第二章 入门', '他拜入了七玄门。'].join('\n'),
    );
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

/** 创建账户、授权小说文件夹,并往条目索引里写入「邮件」「人物」两棵独立来源的树(服务器正在运行,WAL 允许并发写)。 */
async function prepare(page: Page): Promise<void> {
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();
    const cookies = await page.context().cookies();
    const csrf = cookies.find((c) => c.name.toLowerCase().includes('csrf'))?.value ?? '';
    const res = await page.request.post(`${base}/api/v1/fs/roots`, {
        data: { path: join(dir, 'Books'), label: '书架' },
        headers: { 'X-CSRF-Token': csrf },
    });
    expect(res.ok()).toBe(true);
    const conn = openDatabase(join(dir, 'data', 'db.sqlite'));
    try {
        const repos = createRepositories(conn);
        const ownerId = repos.owners.ids()[0]!;
        const put = (type: string, title: string, parentId: string | null, summary: string | null = null) =>
            repos.items.upsert(ownerId, {
                source: 'e2e',
                sourceRef: `${type}:${title}`,
                kind: parentId ? 'content' : 'category',
                type,
                title,
                summary,
                parentId,
            });
        const mail = put('e2e.mail', '邮件', null);
        const inbox = put('e2e.folder', '收件箱', mail.id);
        for (let i = 1; i <= 120; i++) put('e2e.message', `测试邮件 ${i}`, inbox.id, `第 ${i} 封`);
        const people = put('e2e.people', '人物', null);
        const alice = put('e2e.person', 'Alice Example', people.id, 'alice@example.com');
        const bob = put('e2e.person', 'Bob Example', people.id, 'bob@example.com');
        const first = repos.items.children(ownerId, inbox.id, { limit: 1, sort: 'position' }).items[0]!;
        repos.items.relate(ownerId, alice.id, 'mentions', [first.id]);
        void bob;
    } finally {
        conn.close();
    }
}

async function drill(page: Page, mobile: boolean): Promise<void> {
    const open = async (name: string) => {
        if (mobile) await page.getByRole('button', { name: '分类' }).first().click();
        // 只在知识地图页里找分类按钮(工作台侧栏也有「邮件」等同名按钮)
        await page.locator('.items-layout').getByRole('button', { name, exact: true }).first().click();
    };
    // 手机宽度下导航在抽屉里
    if (mobile) await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('link', { name: '知识地图' }).click();
    const sync = page.getByRole('button', { name: '立即同步' });
    await sync.click();
    // 先等同步结束(按钮恢复可用)再开始下钻,否则列表可能还在重新加载
    await expect(sync).toBeEnabled();

    // 小说 → 凡人 → 第二章
    await open('小说');
    await page.locator('.item-row').filter({ hasText: '凡人' }).click();
    await page.locator('.item-row').filter({ hasText: '第二章 入门' }).click();
    await expect(page.locator('.item-text')).toContainText('他拜入了七玄门。');
    if (SHOTS)
        await page.screenshot({ path: join(SHOTS, `novel-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });

    // 邮件 → 收件箱 → 第 1 封;虚拟滚动:120 封只渲染一部分
    await open('邮件');
    await page.locator('.item-row').filter({ hasText: '收件箱' }).click();
    await expect(page.locator('.item-row').first()).toBeVisible();
    expect(await page.locator('.item-row').count()).toBeLessThan(60);
    // 滚到底会触发下一页;反复滚动直到第 100 封出现
    await expect
        .poll(
            async () => {
                await page.locator('.item-list').evaluate((el) => (el.scrollTop = el.scrollHeight));
                // 虚拟列表的行会随滚动被卸载,不能对行调 scrollIntoView;给下一页请求留出时间
                await page.waitForTimeout(250);
                return page.locator('.item-row').filter({ hasText: '测试邮件 100' }).count();
            },
            { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
    await page.locator('.item-list').evaluate((el) => (el.scrollTop = 0));
    await page.locator('.item-row').filter({ hasText: '测试邮件 1' }).first().click();
    await expect(page.locator('.item-content h2')).toBeVisible();
    if (SHOTS)
        await page.screenshot({ path: join(SHOTS, `mail-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });

    // 人物 → Alice(也出现在…)
    await open('人物');
    await page.locator('.item-row').filter({ hasText: 'Alice Example' }).click();
    await expect(page.locator('.item-content h2')).toHaveText('Alice Example');
    await expect(page.getByText('也出现在…')).toBeVisible();
    if (SHOTS)
        await page.screenshot({ path: join(SHOTS, `people-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });

    // 「问 AI」:新建会话,提示词预填且不自动发送
    await page.locator('.item-content').getByRole('button', { name: '问 AI' }).click();
    await expect(page).toHaveURL(/\/s\/[0-9A-Z]{26}$/);
    await expect(page.getByRole('textbox', { name: /输入消息/ })).toHaveValue(/Alice Example/);
}

test('桌面宽度:三个顶层类别下钻到最深条目并打开,「问 AI」预填提示词', async ({ page }) => {
    await prepare(page);
    await drill(page, false);
});

test('手机宽度:树收进抽屉,列表整宽,同样能下钻', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: /登录/ }).click();
    try {
        await expect(page.getByRole('button', { name: '菜单' })).toBeVisible();
        await drill(page, true);
    } finally {
        await ctx.close();
    }
});
