// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 代理页冒烟(ADR 0042 PR 3):新建代理、复制预置角色、在对话里选代理、委派后显示委派树、
// 子代理等审批时能看到带名字的审批卡。假模型是一个按请求内容路由的 OpenAI 兼容端点,不需要真实服务。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
const toolCall = (name: string, args: unknown) =>
    sse(
        {
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: 'call-1',
                                type: 'function',
                                function: { name, arguments: JSON.stringify(args) },
                            },
                        ],
                    },
                },
            ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    );

/** 子代理的请求里有委派提示;委派者收到工具结果后给出总结。 */
function startMock(): Promise<Server> {
    const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
            const parsed = JSON.parse(body || '{}') as { messages?: { role: string; content?: string }[] };
            const messages = parsed.messages ?? [];
            const isChild = messages.some((m) => m.role === 'system' && m.content?.startsWith('Another agent'));
            const hasToolResult = messages.some((m) => m.role === 'tool');
            const wantsDelegate = messages.some((m) => m.role === 'user' && m.content?.includes('请调研'));
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            if (isChild) res.end(text('调研结果:三条要点'));
            else if (wantsDelegate && !hasToolResult) {
                res.end(toolCall('delegate', { agent: '资料员', task: '收集三条要点' }));
            } else res.end(text(hasToolResult ? '已汇总:三条要点' : '普通回答'));
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-agents-e2e-'));
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

test('agents page and delegation tree', async ({ page }) => {
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();

    await page.getByRole('link', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '添加配置档' }).click();
    const profile = page.getByRole('form', { name: 'model-profile' });
    await profile.getByLabel('名称').fill('Fake');
    await profile.getByLabel('接口地址').fill(mockBase);
    await profile.getByLabel('模型').fill('fake-model');
    await profile.getByLabel('密钥引用').fill('env:DEEPSEEK_API_KEY');
    await profile.getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('key-status')).toHaveText('密钥: 已设置');

    // 预置角色可复制;新建代理:工具集里写上 delegate 才能委派
    await page.getByRole('link', { name: '代理' }).click();
    await expect(page.getByTestId('agent-card')).toHaveCount(4);
    await expect(page.getByTestId('agent-card').first().getByRole('button', { name: '删除' })).toHaveCount(0);
    await page.getByTestId('agent-card').first().getByRole('button', { name: '复制' }).click();
    await expect(page.getByTestId('agent-card')).toHaveCount(5);

    await page.getByRole('button', { name: '新建代理' }).click();
    const form = page.getByTestId('agent-form');
    await form.getByLabel('名称').fill('资料员');
    await form.getByLabel('提示词').fill('你负责收集资料,只回答事实。');
    await form.getByLabel('可用工具').fill('time');
    await form.getByRole('button', { name: '保存' }).click();
    await page.getByRole('button', { name: '新建代理' }).click();
    await form.getByLabel('名称').fill('组长');
    await form.getByLabel('可用工具').fill('delegate, time');
    await form.getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('agent-card').filter({ hasText: '组长' })).toContainText('可委派');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'agents-page.png'), fullPage: true });

    // 工具名写错时服务器的校验信息直接显示
    await page.getByRole('button', { name: '新建代理' }).click();
    await form.getByLabel('名称').fill('坏代理');
    await form.getByLabel('可用工具').fill('nope.tool');
    await form.getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.error')).toBeVisible();
    await form.getByRole('button', { name: '取消' }).click();

    // 对话里选「组长」,它把任务委派给「资料员」,消息下面显示委派树
    await page.getByRole('link', { name: '新对话' }).click();
    await page.getByTestId('agent-picker').selectOption({ label: '组长' });
    const composer = page.getByRole('textbox', { name: /输入消息/ });
    await composer.fill('请调研一下这个主题');
    await composer.press('Enter');
    await expect(page.locator('.message.assistant[data-status="complete"]').last()).toContainText('已汇总:三条要点', {
        timeout: 20_000,
    });
    const tree = page.getByTestId('delegation-tree');
    await expect(tree).toBeVisible();
    await expect(tree.getByTestId('tree-node')).toHaveCount(2);
    await expect(tree.getByTestId('tree-node').nth(1)).toContainText('资料员');
    await expect(tree.getByTestId('tree-node').nth(1)).toContainText('完成');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'agents-delegation-tree.png'), fullPage: true });

    // 手机宽度:代理页不横向溢出
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/agents`);
    await expect(page.getByTestId('agent-card').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'agents-page-mobile.png') });
    // 手机上代理选择收在顶部胶囊的模型菜单里,不单独漂在标题栏下面
    await page.goto(base);
    await expect(page.getByTestId('agent-picker')).toBeHidden();
    await page.locator('.wb-pill').click();
    // 模型与代理是菜单里的两个分组,「代理」标题不是选项
    const agentGroup = page.getByRole('group', { name: '代理' });
    await expect(agentGroup).toBeVisible();
    await expect(page.getByRole('option', { name: '代理', exact: true })).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'model-menu-agent-group-390.png') });
    // 默认输入方式是语音,但没有语音识别配置档:输入框照常显示,第一行是一句提示(ADR 0049 第 1.2 节)
    await expect(page.getByTestId('voice-fallback')).toContainText('还没有语音识别模型');
    await expect(page.getByTestId('voice-talk')).toHaveCount(0);
    await agentGroup.getByRole('option', { name: '组长' }).click();
    await expect(page.locator('.wb-pill')).toContainText('组长');
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.getByTestId('agent-picker')).toHaveValue(/.+/);

    // 选「不使用代理」后行为和以前一样:没有委派树
    await page.getByRole('link', { name: '新对话' }).click();
    await page.getByTestId('agent-picker').selectOption({ label: '不使用代理' });
    await composer.fill('你好');
    await composer.press('Enter');
    await expect(page.locator('.message.assistant[data-status="complete"]').last()).toHaveText('普通回答', {
        timeout: 20_000,
    });
    await expect(page.getByTestId('delegation-tree')).toHaveCount(0);
});
