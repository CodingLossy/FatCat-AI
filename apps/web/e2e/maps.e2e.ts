// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆簇与会话地图(ADR 0044 第 6 节):记忆地图定位记忆卡片,会话地图显示 fork 关系并能打开会话 / 跳到知识地图。
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-maps-e2e-'));
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

test('记忆地图与会话地图', async ({ page }) => {
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();
    const csrf = (await page.context().cookies()).find((c) => c.name.toLowerCase().includes('csrf'))?.value ?? '';
    const post = async (path: string, data: unknown) => {
        const res = await page.request.post(`${base}/api/v1${path}`, { data, headers: { 'X-CSRF-Token': csrf } });
        expect(res.ok(), `${path} ${res.status()}`).toBe(true);
        return (await res.json()) as { id?: string };
    };

    // 记忆:三种类型各几条
    const texts: [string, string][] = [
        ['semantic', '用户喜欢喝无糖乌龙茶'],
        ['semantic', '用户住在杭州'],
        ['semantic', '用户的猫叫团团'],
        ['episodic', '上周三和朋友一起看了电影'],
        ['episodic', '周末去了西湖边散步'],
        ['procedural', '写周报时先列本周完成的事项'],
    ];
    for (const [memType, text] of texts) await post('/memory', { text, memType });
    await page.getByRole('link', { name: '记忆', exact: true }).click();
    await expect(page.locator('[data-memory-id]')).toHaveCount(texts.length);
    await page.getByRole('button', { name: '记忆地图' }).click();
    const memoryMap = page.getByTestId('memory-map').getByRole('application');
    await expect(memoryMap).toBeVisible();
    await memoryMap.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('memory-map').getByRole('status')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'memory-map.png'), fullPage: true });

    // 会话:a ← b ← d,a ← c,外加一个独立会话;fork 关系直接写库(应用里还没有创建分叉的入口)
    const ids: Record<string, string> = {};
    for (const name of ['原会话', '分叉一', '分叉二', '再分叉', '独立会话']) {
        ids[name] = (await post('/sessions', { title: name })).id!;
    }
    const conn = openDatabase(join(dir, 'data', 'db.sqlite'));
    try {
        const fork = conn.sqlite.prepare('UPDATE sessions SET forked_from_session_id = ? WHERE id = ?');
        fork.run(ids['原会话'], ids['分叉一']);
        fork.run(ids['原会话'], ids['分叉二']);
        fork.run(ids['分叉一'], ids['再分叉']);
    } finally {
        conn.close();
    }
    await page.goto(`${base}/items`);
    await page.getByRole('button', { name: '会话地图' }).click();
    const sessionMap = page.getByRole('application');
    await expect(sessionMap).toBeVisible();
    await expect(page.getByText('另有 1 个没有分叉关系的会话未显示。')).toBeVisible();
    await sessionMap.focus();
    await page.keyboard.press('ArrowDown');
    await expect(
        page.getByRole('status').filter({ has: page.getByRole('button', { name: '打开会话' }) }),
    ).toBeVisible();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'session-map.png'), fullPage: true });

    // 跳到知识地图:定位到该会话条目
    await page.getByRole('button', { name: '在知识地图中查看' }).click();
    await expect(page).toHaveURL(/\/items$/);
    await expect(page.locator('.item-content h2')).toBeVisible();

    // 回到会话地图,Enter 打开会话
    await page.getByRole('button', { name: '会话地图' }).click();
    await page.getByRole('application').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/s\/[0-9A-Z]{26}$/);
});
