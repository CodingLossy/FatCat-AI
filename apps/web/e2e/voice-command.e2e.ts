// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音指令端到端(ADR 0049 第 5 节):Chromium 假麦克风 → 假 STT 返回预设文字 → 脚本化的假模型按顺序调用工具,
// 界面上依次出现审批卡和面板内容。两条用例:「打开浏览器搜 xxx」与「打开 FatCat-AI 项目,看最近第 3 次改动,修一下 bug」。
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const SHOTS = process.env.FATCAT_SHOTS_DIR;

const SAY_BROWSER = '打开浏览器搜猫粮';
const SAY_CODE = '打开 FatCat-AI 项目,看最近第 3 次改动,修一下 bug';
/** 浏览器用例的地址:.invalid 永远解析不到,服务器取页会失败,不访问外网。 */
const SEARCH_URL = 'https://search.invalid/?q=cat-food';

let dir = '';
let root = '';
let repo = '';
let server: ChildProcess | undefined;
let mock: Server | undefined;
let base = '';
let mockBase = '';
/** 依次作为转写结果返回。 */
const transcripts: string[] = [];
const chatBodies: string[] = [];
/** 模型在调用这个工具之前先等测试放行,好让测试看清面板上一步的内容。 */
let holdBefore: string | null = null;
let release: () => void = () => undefined;

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

const BUGGY = 'module.exports = function sum(a, b) {\n    return a - b;\n};\n';
const FIXED = 'module.exports = function sum(a, b) {\n    return a + b;\n};\n';

/** 两条语音指令各自的工具调用顺序;按本轮已有的工具结果数取下一步,走完后给一句总结。 */
function script(said: string): { steps: [string, unknown][]; done: string } {
    if (said.includes('浏览器')) {
        return {
            steps: [
                ['tools.enable', { group: 'browser' }],
                ['browser.open', { url: SEARCH_URL }],
            ],
            done: '搜索页现在打不开,稍后再试。',
        };
    }
    const file = join(repo, 'sum.js');
    return {
        steps: [
            ['tools.enable', { group: 'code' }],
            ['tools.enable', { group: 'fs' }],
            ['git.show', { project: 'FatCat-AI', nth: 3 }],
            ['fs.read', { path: file }],
            ['fs.write', { path: file, content: FIXED, overwrite: true }],
            ['code.run', { project: 'FatCat-AI', command: 'test' }],
        ],
        done: '第 3 次改动把加法写成了减法,已经改回来,测试通过。',
    };
}

function startMock(): Promise<Server> {
    const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (req.url === '/v1/audio/transcriptions') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ text: transcripts.shift() ?? '' }));
                return;
            }
            chatBodies.push(body);
            const messages =
                (JSON.parse(body || '{}') as { messages?: { role: string; content?: unknown }[] }).messages ?? [];
            const lastUser = messages.map((m) => m.role).lastIndexOf('user');
            const said = typeof messages[lastUser]?.content === 'string' ? (messages[lastUser]!.content as string) : '';
            const done = messages.slice(lastUser + 1).filter((m) => m.role === 'tool').length;
            const { steps, done: summary } = script(said);
            const step = steps[done];
            const answer = () => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(step ? toolCall(`call-${chatBodies.length}`, step[0], step[1]) : text(summary));
            };
            if (step && step[0] === holdBefore) {
                holdBefore = null;
                release = answer;
            } else answer();
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

test.use({
    permissions: ['microphone'],
    launchOptions: {
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
});

test.beforeAll(async () => {
    expect(existsSync(SERVER_ENTRY), 'build apps/server first').toBe(true);
    expect(existsSync(join(WEB_DIST, 'index.html')), 'build apps/web first').toBe(true);
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'fatcat-voice-command-e2e-')));
    root = join(dir, 'projects');
    repo = join(root, 'app');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'sum.js'), FIXED);
    writeFileSync(
        join(repo, 'test.js'),
        'const ok = require("./sum.js")(2, 3) === 5;\nconsole.log(ok ? "sum ok" : "sum broken");\nprocess.exit(ok ? 0 : 1);\n',
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    // 最近第 3 次改动引入了 bug
    writeFileSync(join(repo, 'sum.js'), BUGGY);
    git(repo, 'commit', '-q', '-am', 'refactor: simplify sum');
    writeFileSync(join(repo, 'README.md'), '# app\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'docs: readme');
    writeFileSync(join(repo, 'README.md'), '# app\n\nAdds numbers.\n');
    git(repo, 'commit', '-q', '-am', 'docs: describe the app');

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

/** 假的桌面壳(沿用 browser-panel.e2e.ts 的桩):记录每次 invoke。 */
const FAKE_SHELL = `
window.__calls = [];
window.__TAURI_INTERNALS__ = {
    invoke(cmd, args) {
        window.__calls.push({ cmd, args });
        if (cmd === 'browser_open' || cmd === 'browser_navigate') return Promise.resolve(String(args.url));
        return Promise.resolve(null);
    },
};
`;

async function shot(page: Page, name: string) {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** 语音优先主界面:点一下开始、再点一下结束;假 STT 返回 said。 */
async function speak(page: Page, said: string) {
    transcripts.push(said);
    const talk = page.getByTestId('voice-talk');
    await expect(talk).toHaveAttribute('aria-label', /^点一下开始说话/);
    await talk.click();
    await expect(talk).toHaveAttribute('aria-label', '再点一下结束');
    await page.waitForTimeout(800);
    await talk.click();
    // 假 STT 取走了这一句(主界面字幕只显示当前一句,不保留用户的话)
    await expect.poll(() => transcripts.length, { timeout: 10_000 }).toBe(0);
}

async function login(page: Page, first: boolean) {
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: first ? '创建并登录' : '登录', exact: true }).click();
    await expect(page.locator('.wb-shell')).toBeVisible();
}

async function api(page: Page, method: string, path: string, data: unknown) {
    const csrf = (await page.context().cookies()).find((c) => c.name === 'aip_csrf')!.value;
    const res = await page.request.fetch(`${base}/api/v1${path}`, { method, data, headers: { 'x-csrf-token': csrf } });
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
}

test('说「打开浏览器搜猫粮」:转写 → 开启 browser 组 → browser.open 审批 → 浏览器面板', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(FAKE_SHELL);
    await login(page, true);
    const profile = { kind: 'openai-compatible', baseURL: mockBase, apiKeyRef: null };
    await api(page, 'POST', '/models', { ...profile, label: 'chat', model: 'fake-chat', purpose: ['chat'] });
    await api(page, 'POST', '/models', { ...profile, label: 'stt', model: 'whisper-1', purpose: ['stt'] });
    await api(page, 'PUT', '/settings', {
        voice: { inputMode: 'voice', autoSpeak: false, continuous: false },
        browser: { enabled: true },
    });
    await page.reload();
    await page.goto(base); // 新对话;语音优先时侧栏收在 logo 里

    await speak(page, SAY_BROWSER);
    // 模型先开启 browser 组,再请求打开搜索页:第一次访问这个主机要审批,卡片写出地址
    const card = page.locator('.tool-card.pending');
    await expect(card).toContainText(`Open ${SEARCH_URL} in the browser`, { timeout: 20_000 });
    // 工具调用让浏览器面板跟着打开(假壳里是可以导航的面板)
    await expect(page.getByLabel('地址栏(点击输入新地址)')).toBeVisible();
    await shot(page, 'voice-browser-approval');
    await card.getByRole('button', { name: '批准' }).click();

    // .invalid 解析不到:取页失败,助手如实说明;面板仍在,不显示任何没取到的内容
    await expect(page.getByTestId('voice-caption')).toContainText('搜索页现在打不开', { timeout: 20_000 });
    await expect(page.getByLabel('地址栏(点击输入新地址)')).toBeVisible();
    const sent = chatBodies.join('\n');
    expect(sent).toContain('search.invalid');
    await shot(page, 'voice-browser-done');
});

test('说「打开 FatCat-AI 项目,看最近第 3 次改动,修一下 bug」:提交差异 → 文件差异 → 测试输出', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, false);
    await api(page, 'POST', '/fs/roots', { path: root });
    await api(page, 'PUT', '/settings', {
        code: {
            enabled: true,
            projects: [{ name: 'FatCat-AI', path: repo, commands: [{ name: 'test', argv: ['node', 'test.js'] }] }],
        },
    });
    await page.reload();
    await page.goto(base); // 新对话;语音优先时侧栏收在 logo 里

    holdBefore = 'fs.read';
    await speak(page, SAY_CODE);
    const panel = page.getByTestId('code-panel');

    // 1. git.show nth 3:代码面板显示那次提交的说明和差异(减法就是 bug)
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const commit = panel.getByTestId('code-diff');
    await expect(commit).toContainText('refactor: simplify sum');
    await expect(commit.locator('.diff-ln.add')).toContainText('return a - b;');
    await expect(commit.locator('.diff-ln.del')).toContainText('return a + b;');
    await shot(page, 'voice-code-commit');
    release();

    // 2. fs.read 之后 fs.write:要审批
    const writeCard = page.locator('.tool-card.pending').filter({ hasText: 'fs.write' });
    await expect(writeCard).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText('等待你在审批卡上批准');
    await expect(panel.getByTestId('diff-view')).toContainText('return a + b;');
    expect(readFileSync(join(repo, 'sum.js'), 'utf8')).toBe(BUGGY);
    await shot(page, 'voice-code-write-approval');
    await writeCard.getByRole('button', { name: '批准' }).click();

    // 3. code.run 也每次审批;批准后面板显示退出码与输出末尾
    const runCard = page.locator('.tool-card.pending').filter({ hasText: 'code.run' });
    await expect(runCard).toBeVisible({ timeout: 20_000 });
    expect(readFileSync(join(repo, 'sum.js'), 'utf8')).toBe(FIXED);
    await expect(panel.getByTestId('code-run')).toHaveAttribute('data-state', 'waiting');
    await runCard.getByRole('button', { name: '批准' }).click();
    const run = panel.getByTestId('code-run');
    await expect(run).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
    await expect(run).toContainText('node test.js 退出码 0');
    await expect(run.locator('.code-output')).toContainText('sum ok');
    await expect(page.getByTestId('voice-caption')).toContainText('测试通过', { timeout: 20_000 });

    // 模型拿到的是那次提交的内容(不可信内容包装)
    expect(chatBodies.join('\n')).toContain('refactor: simplify sum');
    await expect(panel).toContainText('正在修改');
    await shot(page, 'voice-code-done');
});
