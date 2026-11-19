// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 工作台冒烟(M12 PR 3):顶栏(版本、全局搜索、模型胶囊)、左侧 RUNNING TOOLS、导轨,
// 以及助手列文件夹 / 读文件时右侧面板自动切到文件树 + 预览。假模型是按请求内容路由的 OpenAI 兼容端点。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = join(here, '../../server/dist/index.js');
const WEB_DIST = join(here, '../dist');
const PASSWORD = 'correct horse battery staple';
const FAKE_KEY = 'sk-test-THIS-IS-NOT-A-REAL-KEY-0123456789';
const SHOTS = process.env.FATCAT_SHOTS_DIR;

let dir = '';
let root = '';
let server: ChildProcess | undefined;
let mock: Server | undefined;
let base = '';
let mockBase = '';

const sse = (...events: unknown[]) => `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
const text = (content: string) =>
    sse(
        { choices: [{ index: 0, delta: { content } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 5 } },
    );
const toolCall = (id: string, name: string, args: unknown) =>
    sse(
        {
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
                        ],
                    },
                },
            ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    );

/** 先列文件夹,再读 notes.ts,最后总结。 */
function startMock(): Promise<Server> {
    const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
            const parsed = JSON.parse(body || '{}') as { messages?: { role: string; content?: string }[] };
            const results = (parsed.messages ?? []).filter((m) => m.role === 'tool').length;
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            if (results === 0) res.end(toolCall('call-1', 'fs.list', { path: root }));
            else if (results === 1) res.end(toolCall('call-2', 'fs.read', { path: join(root, 'notes.ts') }));
            else res.end(text('文件夹里有 notes.ts 和 docs。'));
        });
    });
    return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s)));
}

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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-workbench-e2e-'));
    root = join(dir, 'project');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'notes.ts'), 'export const answer = 42;\n// 第二行\n');
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
    await new Promise<void>((r) => (mock ? mock.close(() => r()) : r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
});

test('workbench: top bar, running tools, file panel follows fs tools', async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 800 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();

    // 顶栏:没有模型配置档时显示「未选择模型」,版本来自核心
    await expect(page.locator('.model-capsule')).toContainText('未选择模型');
    await expect(page.getByTestId('server-version')).toContainText(/^v\d/);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'workbench-empty.png') });

    // 授权文件夹、添加模型配置档
    const csrf = (await page.context().cookies()).find((c) => c.name.toLowerCase().includes('csrf'))?.value ?? '';
    const roots = await page.request.post(`${base}/api/v1/fs/roots`, {
        data: { path: root, label: 'project' },
        headers: { 'X-CSRF-Token': csrf },
    });
    expect(roots.ok()).toBe(true);
    await page.locator('.model-capsule').click();
    await page.getByRole('button', { name: '添加配置档' }).click();
    const profile = page.getByRole('form', { name: 'model-profile' });
    await profile.getByLabel('名称').fill('Fake');
    await profile.getByLabel('接口地址').fill(mockBase);
    await profile.getByLabel('模型').fill('fake-model');
    await profile.getByLabel('密钥引用').fill('env:DEEPSEEK_API_KEY');
    await profile.getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('key-status')).toHaveText('密钥: 已设置');
    await page.getByRole('link', { name: '新对话' }).click();
    await expect(page.locator('.model-capsule')).toContainText('Fake');

    // 全局搜索:命令组与「提问」只预填输入框,不发送
    const search = page.getByRole('combobox', { name: '全局搜索' });
    await page.keyboard.press('Control+k');
    await expect(search).toBeFocused();
    await search.fill('设置');
    await expect(page.getByRole('option', { name: '打开设置' })).toBeVisible();
    await search.fill('帮我看看项目文件夹');
    await page.getByRole('option', { name: /向助手提问/ }).click();
    await expect(page.getByRole('textbox', { name: /输入消息/ })).toHaveValue('帮我看看项目文件夹');
    await expect(page.getByTestId('messages').locator('.message')).toHaveCount(0);

    // 发送后:RUNNING TOOLS 显示 fs.list / fs.read,右侧面板自动切到文件树 + 预览
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.getByTestId('files-panel')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('running-tools')).toContainText('fs.read');
    await expect(page.getByTestId('file-lines')).toContainText('export const answer = 42;');
    await expect(page.locator('.file-tree').first()).toContainText('docs');
    await expect(page.getByTestId('captions')).toContainText('notes.ts');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'workbench-files.png') });

    // 手动点导轨会固定面板;切回对话后消息仍在
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await expect(page.getByTestId('messages')).toContainText('文件夹里有 notes.ts');
    await expect(page.getByTestId('files-panel')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'workbench-chat.png') });

    // 窄屏:单栏堆叠,没有横向滚动
    await page.setViewportSize({ width: 390, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.locator('#sidebar')).toBeHidden();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'workbench-narrow.png') });
});
