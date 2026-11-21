// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 知识(M12 knowledge-hero):一个入口,星图逐层展开、气泡、全文卡片、Esc 返回、搜索点亮、列表视图。
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-knowledge-e2e-'));
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
    await page.waitForTimeout(900);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test('知识:星图逐层展开、气泡、全文卡片、Esc 返回、搜索点亮、列表视图', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByTestId('voice-indicator')).toBeVisible();
    const csrf = (await page.context().cookies()).find((c) => c.name.toLowerCase().includes('csrf'))?.value ?? '';
    const texts: [string, string][] = [
        ['semantic', '用户喜欢喝无糖乌龙茶。每天下午一杯。'],
        ['semantic', '用户住在杭州西湖区。'],
        ['semantic', '用户的猫叫团团。'],
        ['episodic', '上周三和朋友一起看了电影。'],
        ['procedural', '写周报时先列本周完成的事项。'],
    ];
    for (const [memType, text] of texts) {
        const res = await page.request.post(`${base}/api/v1/memory`, {
            data: { text, memType },
            headers: { 'X-CSRF-Token': csrf },
        });
        expect(res.ok()).toBe(true);
    }

    // 侧栏只有一个「知识」入口,没有单独的「记忆」和「知识地图」
    const side = page.getByRole('complementary', { name: /侧栏|Sidebar/ });
    await expect(page.getByRole('link', { name: '知识地图' })).toHaveCount(0);
    await page.getByRole('link', { name: '知识', exact: true }).click();
    await expect(page.getByTestId('knowledge')).toBeVisible();
    await expect(side.getByRole('button', { name: '记忆', exact: true })).toHaveCount(0);
    await shot(page, 'tech-knowledge-roots');

    // 键盘:第一层是记忆三类;回车展开
    const nodes = page.getByRole('list', { name: '当前这一层' });
    await nodes.getByRole('button', { name: '语义记忆' }).focus();
    await page.keyboard.press('Enter');
    const crumbs = page.getByRole('navigation', { name: '知识路径' });
    await expect(crumbs).toContainText('语义记忆');
    await expect(nodes.getByRole('button')).toHaveCount(3);
    await shot(page, 'tech-knowledge-open');

    // 子项:回车浮出一句原文的气泡,点气泡打开全文卡片
    await nodes.getByRole('button', { name: /无糖乌龙茶/ }).focus();
    await page.keyboard.press('Enter');
    const bubble = page.getByTestId('knowledge-bubble');
    await expect(bubble).toHaveText('用户喜欢喝无糖乌龙茶。');
    await shot(page, 'tech-knowledge-bubble');
    await bubble.click();
    const card = page.getByTestId('knowledge-card');
    await expect(card).toContainText('每天下午一杯');
    await card.getByRole('button', { name: '置顶' }).click();
    await expect(card.getByRole('button', { name: '取消置顶' })).toBeVisible();
    await shot(page, 'tech-knowledge-card');

    // Esc:先关卡片,再关气泡,再回到上一层
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(bubble).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(crumbs).not.toContainText('语义记忆');

    // 搜索:命中的记忆和它所在的类别都点亮
    await page.getByRole('searchbox', { name: '搜索知识和记忆' }).fill('杭州');
    await expect(nodes.getByRole('button', { name: /语义记忆 \(搜索命中\)/ })).toBeVisible();
    await shot(page, 'tech-knowledge-search');

    // 列表视图保留批量管理
    await page.getByRole('radio', { name: '列表' }).click();
    await expect(page.locator('[data-memory-id]')).toHaveCount(texts.length);

    // 自然主题:树枝是分类,点开后叶子挂在枝头,叶旁浮出同样的气泡
    const put = await page.request.put(`${base}/api/v1/settings`, {
        data: { theme: 'nature' },
        headers: { 'X-CSRF-Token': csrf },
    });
    expect(put.ok()).toBe(true);
    await page.goto(`${base}/knowledge`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nature');
    await page.getByRole('radio', { name: '星图' }).click();
    await nodes.getByRole('button', { name: '语义记忆' }).focus();
    await page.keyboard.press('Enter');
    await expect(nodes.getByRole('button')).toHaveCount(3);
    await nodes.getByRole('button', { name: /无糖乌龙茶/ }).focus();
    await page.keyboard.press('Enter');
    await expect(bubble).toHaveText('用户喜欢喝无糖乌龙茶。');
    await shot(page, 'nature-knowledge');
});
