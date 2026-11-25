// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 「代码」面板(ADR 0049 第 4 节):真实的 git 仓库登记为项目,假模型依次调用 git.log、git.show 和 code.run,
// 面板显示提交列表、差异和测试输出;code.run 的审批卡单独高亮助手追加的参数。面板内容全部来自工具调用。
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = join(here, '../../server/dist/index.js');
const WEB_DIST = join(here, '../dist');
const PASSWORD = 'correct horse battery staple';
const FAKE_KEY = 'sk-test-THIS-IS-NOT-A-REAL-KEY-0123456789';
const SHOTS = process.env.FATCAT_SHOTS_DIR;
/** 截图用:换主题再跑一遍(tech / nature / cat)。 */
const THEME = process.env.FATCAT_SHOTS_THEME;

let dir = '';
let root = '';
let repo = '';
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

/** 按已有的工具结果数依次走:开启 code 组 → git.log → git.show → code.run → 总结。 */
const STEPS: [string, unknown][] = [
    ['tools.enable', { group: 'code' }],
    ['git.log', { project: 'FatCat-AI' }],
    ['git.show', { project: 'FatCat-AI', nth: 1 }],
    ['code.run', { project: 'FatCat-AI', command: 'test', args: ['--filter=core'] }],
];

function startMock(): Promise<Server> {
    const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
            const parsed = JSON.parse(body || '{}') as { messages?: { role: string }[] };
            const done = (parsed.messages ?? []).filter((m) => m.role === 'tool').length;
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const step = STEPS[done];
            res.end(step ? toolCall(`call-${done + 1}`, step[0], step[1]) : text('测试通过,最近一次改动修了标题。'));
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

function git(cwd: string, ...args: string[]) {
    execFileSync('git', ['-c', 'user.name=Shy', '-c', 'user.email=shy@example.com', ...args], { cwd });
}

test.beforeAll(async () => {
    expect(existsSync(SERVER_ENTRY), 'build apps/server first').toBe(true);
    expect(existsSync(join(WEB_DIST, 'index.html')), 'build apps/web first').toBe(true);
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'fatcat-code-panel-e2e-')));
    root = join(dir, 'projects');
    repo = join(root, 'app');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'title.txt'), 'Old title\n');
    writeFileSync(join(repo, 'test.js'), 'console.log("12 tests passed", process.argv.slice(2).join(" "));\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    writeFileSync(join(repo, 'title.txt'), 'New title\n');
    git(repo, 'commit', '-q', '-am', 'fix: correct the page title');

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

/** 在页面里调用公开 API(同源 Cookie 会话 + CSRF 令牌)。 */
async function call(page: Page, method: string, path: string, body: unknown): Promise<number> {
    return page.evaluate(
        async ({ method, path, body }) => {
            const csrf = /(?:^|; )aip_csrf=([^;]*)/.exec(document.cookie)?.[1] ?? '';
            const res = await fetch(path, {
                method,
                headers: { 'content-type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
                body: JSON.stringify(body),
            });
            return res.status;
        },
        { method, path, body },
    );
}

async function shot(page: Page, name: string) {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${THEME ?? 'tech'}-${name}.png`) });
}

test('代码面板:提交列表、差异与测试输出;审批卡高亮追加的参数', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();

    expect(
        await call(page, 'POST', '/api/v1/models', {
            label: 'Fake',
            kind: 'openai-compatible',
            baseURL: mockBase,
            apiKeyRef: 'env:DEEPSEEK_API_KEY',
            model: 'fake-model',
            purpose: ['chat'],
        }),
    ).toBe(201);
    expect(await call(page, 'POST', '/api/v1/fs/roots', { path: root })).toBe(201);
    expect(
        await call(page, 'PUT', '/api/v1/settings', {
            voice: { inputMode: 'text' },
            ...(THEME ? { theme: THEME } : {}),
            code: {
                enabled: true,
                projects: [{ name: 'FatCat-AI', path: repo, commands: [{ name: 'test', argv: ['node', 'test.js'] }] }],
            },
        }),
    ).toBe(200);
    await page.reload();

    // 打开编码项目后侧栏多了「代码」;空面板说明内容从哪里来
    await page.getByRole('button', { name: '代码', exact: true }).click();
    await expect(page.getByText('这里会显示提交、差异和测试输出')).toBeVisible();
    await page.getByRole('button', { name: '收起面板' }).click();

    const composer = page.getByRole('textbox', { name: /输入消息/ });
    await composer.fill('打开 FatCat-AI 项目,看最近一次改动,再跑一下测试');
    await composer.press('Enter');

    // code.run 每次审批:审批卡单独列出助手追加的参数
    const added = page.getByTestId('added-args');
    await expect(added).toBeVisible({ timeout: 20_000 });
    await expect(added).toContainText('--filter=core');
    const panel = page.getByTestId('code-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('code-run')).toHaveAttribute('data-state', 'waiting');
    await expect(panel.locator('.code-commit')).toHaveCount(2);
    await expect(panel.locator('.code-commit').first()).toContainText('fix: correct the page title');
    const diff = panel.getByTestId('code-diff');
    await expect(diff.locator('.diff-ln.del')).toContainText('Old title');
    await expect(diff.locator('.diff-ln.add')).toContainText('New title');
    await shot(page, 'code-panel-approval');

    await page.getByRole('button', { name: '批准' }).click();
    await expect(page.locator('.message.assistant[data-status="complete"]').last()).toContainText('测试通过', {
        timeout: 20_000,
    });
    const run = panel.getByTestId('code-run');
    await expect(run).toHaveAttribute('data-state', 'done');
    await expect(run).toContainText('node test.js --filter=core 退出码 0');
    await expect(run.locator('.code-output')).toContainText('12 tests passed --filter=core');

    // 没被 git.show 打开过的提交:提示让助手打开,不自己去读
    await panel.locator('.code-commit').nth(1).click();
    await expect(panel.getByText('这次改动还没打开')).toBeVisible();
    await panel.locator('.code-commit').first().click();
    await expect(panel.locator('.code-commit').first()).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'code-panel-done');

    // 手机:代码面板是底部标签;重新载入后内容从已保存的消息里重建
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '代码' }).click();
    await expect(page.getByTestId('code-panel')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'code-panel-mobile');
});
