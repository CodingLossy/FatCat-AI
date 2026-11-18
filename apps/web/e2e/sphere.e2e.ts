// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 知识地图粒子球(ADR 0044 第 5 节):键盘下钻 / 返回,以及合成 1 万条目的帧时间。
// 真实 GPU / 真机上的 60 fps 只能由业主确认;这里量的是无头 Chromium(软件渲染)的数字,门槛放宽。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepositories, openDatabase } from '@fatcat-ai/storage';
import { buildSync } from 'esbuild';
import { expect, test } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = join(here, '../../server/dist/index.js');
const WEB_DIST = join(here, '../dist');
const SPHERE_SRC = join(here, '../../../packages/ui/src/knowledge-sphere/index.ts');
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-sphere-e2e-'));
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

test('粒子球:键盘选中、回车下钻、Esc 返回上一层', async ({ page }) => {
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();

    // 三层:知识库 → 8 个子类别 → 各 6 个条目(服务器正在运行,WAL 允许并发写)。
    const conn = openDatabase(join(dir, 'data', 'db.sqlite'));
    try {
        const repos = createRepositories(conn);
        const ownerId = repos.owners.ids()[0]!;
        const put = (type: string, title: string, parentId: string | null, kind: 'category' | 'content') =>
            repos.items.upsert(ownerId, {
                source: 'e2e',
                sourceRef: `${type}:${title}:${parentId ?? ''}`,
                kind,
                type,
                title,
                summary: null,
                parentId,
            });
        const root = put('e2e.root', '知识库', null, 'category');
        for (let c = 1; c <= 8; c++) {
            const cat = put('e2e.category', `主题 ${c}`, root.id, 'category');
            for (let i = 1; i <= 6; i++) put('e2e.note', `笔记 ${c}-${i}`, cat.id, 'content');
        }
    } finally {
        conn.close();
    }

    await page.getByRole('link', { name: '知识地图' }).click();
    await page.getByRole('button', { name: '立即同步' }).click();
    await page.getByRole('button', { name: '知识库', exact: true }).first().click();
    await page.getByRole('button', { name: '粒子球' }).click();
    const canvas = page.getByRole('application');
    await expect(canvas).toBeVisible();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'sphere-top.png'), fullPage: true });

    // 方向键选中一个点,回车下钻到它的子项,面包屑多一级
    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('status').filter({ hasText: '已选中:主题' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.breadcrumb')).toContainText('主题');
    await expect(canvas).toBeVisible();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'sphere-drilled.png'), fullPage: true });

    // Esc 回到上一层
    await canvas.focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('.breadcrumb')).not.toContainText('主题');

    // 切回列表
    await page.getByRole('button', { name: '列表' }).click();
    await expect(page.locator('.item-row').first()).toBeVisible();
});

test('粒子球:1 万个点的帧时间与切层时间(无头 Chromium,软件渲染)', async ({ page }) => {
    const bundle = buildSync({
        entryPoints: [SPHERE_SRC],
        bundle: true,
        write: false,
        format: 'iife',
        globalName: 'Sphere',
        platform: 'browser',
    }).outputFiles[0]!.text;
    await page.setContent('<canvas id="c" style="width:560px;height:560px"></canvas>');
    await page.addScriptTag({ content: bundle });
    const result = await page.evaluate(() => {
        const S = (window as unknown as { Sphere: typeof import('@fatcat-ai/ui') }).Sphere;
        const canvas = document.getElementById('c') as HTMLCanvasElement;
        const sphere = S.createKnowledgeSphere(canvas, { reducedMotion: true })!;
        const items = Array.from({ length: 10_000 }, (_, i) => ({
            id: `n${i}`,
            label: `Item ${i}`,
            weight: (i * 37) % 5000,
            category: i % 5 === 0,
        }));
        const t0 = performance.now();
        sphere.setItems(items);
        sphere.renderOnce();
        const switchMs = performance.now() - t0;
        const frames: number[] = [];
        for (let i = 0; i < 60; i++) frames.push(sphere.renderOnce());
        frames.sort((a, b) => a - b);
        sphere.destroy();
        return { switchMs, median: frames[30]!, p95: frames[56]! };
    });
    console.log(
        `sphere 10k: switch ${result.switchMs.toFixed(1)} ms, frame median ${result.median.toFixed(2)} ms, p95 ${result.p95.toFixed(2)} ms`,
    );
    expect(result.switchMs).toBeLessThan(600);
    // 60 fps 需要 16.7 ms;CI 无头软件渲染放宽到 33 ms(30 fps)。真机 GPU 数字由业主确认。
    expect(result.median).toBeLessThan(33);
});
