// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// Web UI 冒烟(M1 方案第 8 节第 8 项,ADR 0009 第 6 节):启动构建后的 server(托管 apps/web/dist)和一个
// 慢速回放 DeepSeek fixture 的假端点,在浏览器里完成初始化 → 配置档 → 流式中刷新 → 审批 → 记忆管理。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Interaction, loadFixture } from '@fatcat-ai/eval';
import { expect, test } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = join(here, '../../server/dist/index.js');
const WEB_DIST = join(here, '../dist');
const FIXTURES = join(here, '../../../packages/providers/test/fixtures');
const PASSWORD = 'correct horse battery staple';
/** 明显是假的密钥,只用来让 keyStatus 显示为「已设置」;假端点不校验它。 */
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
    dir = mkdtempSync(join(tmpdir(), 'fatcat-web-e2e-'));
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

test('初始化、配置档、流式中刷新、审批与记忆管理', async ({ page }) => {
    page.on('dialog', (d) => void d.accept());

    // 首次启动:创建主人账户(本机请求不需要设置码)
    await page.goto(base);
    await expect(page.getByRole('heading', { name: '创建主人账户' })).toBeVisible();
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();

    // 配置档:明文密钥被拒绝,env: 引用可保存并显示 keyStatus
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '添加配置档' }).click();
    const form = page.getByRole('form', { name: 'model-profile' });
    await form.getByLabel('名称').fill('DeepSeek');
    await form.getByLabel('接口地址').fill(mockBase);
    await form.getByLabel('模型').fill('deepseek-chat');
    await form.getByLabel('密钥引用').fill(FAKE_KEY);
    await expect(form.getByText('密钥引用必须是 env:NAME 或 file:NAME')).toBeVisible();
    await expect(form.getByRole('button', { name: '保存' })).toBeDisabled();
    await form.getByLabel('密钥引用').fill('env:DEEPSEEK_API_KEY');
    await form.getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('key-status')).toHaveText('密钥: 已设置');

    // 发送消息,在流式途中刷新页面,回复应续看并完整出现
    enqueue('deepseek-chat-stream', 1500);
    await page.getByRole('link', { name: '新对话' }).click();
    const composer = page.getByRole('textbox', { name: /输入消息/ });
    await composer.fill('请只回复四个字:你好世界');
    await composer.press('Enter');
    await expect(page.getByTestId('live')).toContainText('你好');
    await expect(page.getByTestId('live')).not.toContainText('你好世界');
    await expect(page).toHaveURL(/\/s\/[0-9A-Z]{26}$/);
    await page.reload();
    await expect(page.getByTestId('live')).toContainText('你好');
    await expect(page.locator('.message.assistant[data-status="complete"]')).toHaveText('你好世界', {
        timeout: 15_000,
    });
    await expect(page.getByTestId('live')).toHaveCount(0);

    // memory.save:普通信息按条件预授权直接写入,并显示可撤销提示;撤销即删除(ADR 0010 第 4 节)
    enqueue('memory-save-roundtrip');
    await composer.fill('记住我住杭州');
    await composer.press('Enter');
    const remembered = page.getByTestId('remembered').last();
    await expect(remembered).toContainText('已记住:用户常住杭州');
    await expect(page.getByRole('button', { name: '拒绝' })).toHaveCount(0);
    await remembered.getByRole('button', { name: '撤销' }).click();
    await expect(remembered).toHaveText('已撤销这条记忆');
    await page.getByRole('link', { name: '记忆' }).click();
    await expect(page.getByText('还没有记忆。')).toBeVisible();

    // 再写一次,保留下来
    await page.getByRole('link', { name: '新对话' }).click();
    enqueue('memory-save-roundtrip');
    await composer.fill('记住我住杭州');
    await composer.press('Enter');
    await expect(page.getByTestId('remembered').last()).toContainText('已记住:用户常住杭州');

    // 更替已有的画像事实需要审批:拒绝后不写入,原值不变
    await page.getByRole('link', { name: '新对话' }).click();
    enqueue('memory-save-supersede');
    await composer.fill('我搬到上海了');
    await composer.press('Enter');
    await page.getByRole('button', { name: '拒绝' }).click();
    await expect(page.locator('.message.assistant').last()).toContainText('好的,已更新。');
    await page.getByRole('link', { name: '记忆' }).click();
    await expect(page.locator('.memory')).toHaveCount(1);
    await expect(page.locator('.memory')).toContainText('用户常住杭州');

    // 批准后更替
    await page.getByRole('link', { name: '新对话' }).click();
    enqueue('memory-save-supersede');
    await composer.fill('我搬到上海了');
    await composer.press('Enter');
    // 批准时选择「总是允许」:之后可以在设置中看到并撤销(ADR 0010 第 3 节)
    await page.getByRole('combobox', { name: '记住这个决定' }).selectOption('always');
    await page.getByRole('button', { name: '批准' }).click();
    await expect(page.locator('.message.assistant').last()).toContainText('好的,已更新。');

    // 反馈(验收 ⑤):问到上海时,「本次用到的记忆」里出现这条;点「错误」并填写更正,立即生效
    enqueue('deepseek-chat-stream');
    await composer.fill('我是不是住在上海');
    await composer.press('Enter');
    const used = page.getByTestId('used-memories');
    await used.locator('summary').click();
    await expect(used).toContainText('用户搬到了上海');
    await used.getByRole('button', { name: '错误' }).click();
    await used.getByRole('textbox', { name: '正确的内容' }).fill('用户住在苏州');
    await used.getByRole('button', { name: '保存' }).click();
    await expect(used).toContainText('已更正');

    // 记忆页:只看到更正后的值,历史中能看到更替链;编辑、忘记(验收 ⑦)
    await page.getByRole('link', { name: '记忆' }).click();
    const item = page.locator('.memory');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('用户住在苏州');
    await item.getByRole('button', { name: '历史' }).click();
    await expect(page.getByTestId('memory-history')).toContainText('用户搬到了上海 · superseded');
    await expect(page.getByTestId('memory-history')).toContainText('用户常住杭州 · superseded');
    await item.getByRole('button', { name: '编辑' }).click();
    await item.getByRole('textbox').fill('用户常住杭州西湖区');
    await item.getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.memory-text')).toHaveText('用户常住杭州西湖区');
    await page.locator('.memory').getByRole('button', { name: '删除' }).click();
    await expect(page.getByText('还没有记忆。')).toBeVisible();

    // 审计页:两次条件预授权写入、撤销、拒绝、批准、新增预授权与忘记都有记录
    await page.getByRole('link', { name: '审计' }).click();
    await expect(page.locator('.audit-table tbody tr')).toHaveCount(7);
    await expect(page.locator('.audit-table')).toContainText('撤销记忆');
    await expect(page.locator('.audit-table')).toContainText('已拒绝');
    await expect(page.locator('.audit-table')).toContainText('新增预授权');

    // 设置页:撤销预授权
    await page.getByRole('link', { name: '设置' }).click();
    const preauth = page.locator('[data-preauth="memory.save"]');
    await expect(preauth).toContainText('总是允许');
    await preauth.getByRole('button', { name: '撤销' }).click();
    await expect(page.getByText('还没有预授权。')).toBeVisible();

    // 知识地图(M2 验收第 5 条):授权含小说的文件夹后,「小说 → 某书 → 某章」逐层下钻并打开
    const books = join(realpathSync.native(dir), 'Books');
    mkdirSync(books);
    writeFileSync(join(books, '凡人.txt'), '第一章 山村少年\n他出生在一个小山村。\n第二章 入门\n他拜入了七玄门。\n');
    await page.getByRole('textbox', { name: '文件夹路径' }).fill(books);
    await page.getByRole('button', { name: '授权', exact: true }).click();
    await expect(page.locator(`[data-fs-root="${books.replaceAll('\\', '\\\\')}"]`)).toBeVisible();
    await page.getByRole('link', { name: '知识地图' }).click();
    await page.getByRole('button', { name: '立即同步' }).click();
    await page.getByRole('button', { name: /小说/ }).click();
    await page.getByRole('button', { name: /凡人/ }).click();
    await page.getByRole('button', { name: '第二章 入门' }).click();
    await expect(page.locator('.item-text')).toHaveText('第二章 入门\n他拜入了七玄门。\n');
    await expect(page.locator('.breadcrumb')).toHaveText('小说 › 凡人 › 第二章 入门');
});
