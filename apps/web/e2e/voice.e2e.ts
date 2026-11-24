// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音冒烟(M4 方案 PR 5):Chromium 的假麦克风走完「按住说话 → 转写 → 回复 → 朗读」。
// 假端点同时提供 OpenAI 兼容的 /audio/transcriptions、/audio/speech 与对话流(回放 DeepSeek fixture)。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
const TRANSCRIPT = '请只回复四个字:你好世界';

let dir = '';
let server: ChildProcess | undefined;
let mock: Server | undefined;
let base = '';
let mockBase = '';
const chatQueue: Interaction[] = [];
/** 为 true 时,对话请求先挂着不回,直到 releaseChat() 被调用(测「停止」按钮)。 */
let holdChat = false;
let releaseChat: () => void = () => undefined;
const seen: { path: string; contentType: string; body: string }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 0.6 秒 440 Hz 的 16 位单声道 WAV(合成)。 */
function toneWav(): Buffer {
    const rate = 8000;
    const samples = Math.round(rate * 0.6);
    const buf = Buffer.alloc(44 + samples * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + samples * 2, 4);
    buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) {
        buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
    }
    return buf;
}

function startMock(): Promise<Server> {
    const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            seen.push({ path: req.url ?? '', contentType: req.headers['content-type'] ?? '', body });
            if (req.url === '/v1/audio/transcriptions') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ text: TRANSCRIPT }));
                return;
            }
            if (req.url === '/v1/audio/speech') {
                res.writeHead(200, { 'content-type': 'audio/wav' });
                res.end(toneWav());
                return;
            }
            if (holdChat) {
                holdChat = false;
                req.socket.once('close', () => releaseChat());
                releaseChat = () => {
                    releaseChat = () => undefined;
                    if (!res.writableEnded) res.destroy();
                };
                return;
            }
            const next = chatQueue.shift();
            if (!next || req.url !== next.request.path) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
                return;
            }
            res.writeHead(next.response.status, next.response.headers);
            for (const chunk of next.response.chunks) res.write(chunk);
            res.end();
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

test.use({
    permissions: ['microphone'],
    launchOptions: {
        args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
        ],
    },
});

test.beforeAll(async () => {
    expect(existsSync(SERVER_ENTRY), 'build apps/server first').toBe(true);
    expect(existsSync(join(WEB_DIST, 'index.html')), 'build apps/web first').toBe(true);
    dir = mkdtempSync(join(tmpdir(), 'fatcat-voice-e2e-'));
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

test('按住说话 → 转写 → 回复 → 朗读', async ({ page }) => {
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();

    // 三个配置档与「自动朗读」通过 API 设置(同源 Cookie 会话 + CSRF)
    const csrf = (await page.context().cookies()).find((c) => c.name === 'aip_csrf')!.value;
    const post = async (path: string, data: unknown, method = 'POST') => {
        const res = await page.request.fetch(`${base}/api/v1${path}`, {
            method,
            data,
            headers: { 'x-csrf-token': csrf },
        });
        expect(res.ok(), `${method} ${path}`).toBe(true);
    };
    const profile = { kind: 'openai-compatible', baseURL: mockBase, apiKeyRef: null };
    await post('/models', { ...profile, label: 'chat', model: 'deepseek-chat', purpose: ['chat'] });
    await post('/models', { ...profile, label: 'stt', model: 'whisper-1', purpose: ['stt'] });
    await post('/models', { ...profile, label: 'tts', model: 'tts-1', purpose: ['tts'] });
    // 这条用例走文字模式里的「按住说话」;语音优先的主界面在下一条用例里测
    await post('/settings', { voice: { autoSpeak: true, inputMode: 'text' } }, 'PUT');

    chatQueue.push(...loadFixture(join(FIXTURES, 'deepseek-chat-stream.json')).interactions);
    // 重新加载,让聊天页读到新的配置档与设置
    await page.reload();
    await page.getByRole('link', { name: '新对话' }).click();
    const indicator = page.getByTestId('voice-indicator');
    await expect(indicator).toHaveAttribute('data-state', 'idle');

    // 按住约 1.5 秒再松开
    const button = page.getByTestId('voice-button');
    await expect(button).toHaveText('按住说话');
    await button.hover();
    await page.mouse.down();
    await expect(indicator).toHaveAttribute('data-state', 'listening');
    await expect(indicator).toContainText('正在听…');
    await sleep(1500);
    await page.mouse.up();

    // 转写后自动发送,回复完成后自动朗读
    await expect(page.locator('.message.user').first()).toHaveText(TRANSCRIPT);
    await expect(page.locator('.message.assistant[data-status="complete"]')).toContainText('你好世界', {
        timeout: 15_000,
    });
    await expect(indicator).toHaveAttribute('data-state', 'speaking', { timeout: 10_000 });
    await expect(indicator).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });

    const stt = seen.find((r) => r.path === '/v1/audio/transcriptions')!;
    expect(stt.contentType).toMatch(/^multipart\/form-data/);
    expect(stt.body).toMatch(/filename="audio\.(webm|ogg|m4a)"/);
    const tts = seen.find((r) => r.path === '/v1/audio/speech')!;
    expect(JSON.parse(tts.body)).toMatchObject({ model: 'tts-1', input: '你好世界', voice: 'alloy' });

    // 另一个端上报的状态经服务器推过来(带服务器生成的文字)
    const tokenRes = await page.request.fetch(`${base}/api/v1/tokens`, {
        method: 'POST',
        data: { name: 'e2e' },
        headers: { 'x-csrf-token': csrf },
    });
    const { token } = (await tokenRes.json()) as { token: string };
    const Ws = globalThis.WebSocket as unknown as new (
        url: string,
        init: { headers: Record<string, string> },
    ) => WebSocket;
    const other = new Ws(`${base.replace('http', 'ws')}/api/v1/ws`, { headers: { authorization: `Bearer ${token}` } });
    await new Promise((r) => other.addEventListener('open', r, { once: true }));
    other.send(JSON.stringify({ v: 1, type: 'hello', id: 'h', payload: { protocolVersion: 1 } }));
    await new Promise((r) => other.addEventListener('message', r, { once: true }));
    other.send(
        JSON.stringify({ v: 1, type: 'voice-state', id: 'v', payload: { state: 'listening', sessionId: null } }),
    );
    await expect(indicator).toHaveAttribute('data-state', 'listening');
    await expect(indicator).toContainText('正在听…');
    // 那个端断开时,服务器替它发 idle
    other.close();
    await expect(indicator).toHaveAttribute('data-state', 'idle');

    // 回复旁的「朗读」按钮
    await page.locator('.message.assistant').getByRole('button', { name: '朗读' }).click();
    await expect(indicator).toHaveAttribute('data-state', 'speaking', { timeout: 10_000 });
    await expect(page.locator('.message.assistant').getByRole('button', { name: '停止朗读' })).toBeVisible();
});

test('语音优先:点按说话、字幕、文字弹窗发送后收起(ADR 0049 第 1 节)', async ({ page }) => {
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();
    const csrf = (await page.context().cookies()).find((c) => c.name === 'aip_csrf')!.value;
    const res = await page.request.fetch(`${base}/api/v1/settings`, {
        method: 'PUT',
        data: { voice: { autoSpeak: false, inputMode: 'voice' } },
        headers: { 'x-csrf-token': csrf },
    });
    expect(res.ok()).toBe(true);

    chatQueue.push(...loadFixture(join(FIXTURES, 'deepseek-chat-stream.json')).interactions);
    // 麦克风启动推迟 500 ms,用来测「启动期间按 Esc」
    await page.addInitScript(() => {
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
            await new Promise((r) => setTimeout(r, 500));
            return original(constraints);
        };
    });
    await page.reload();
    await page.getByRole('link', { name: '新对话' }).click();

    // 主界面只有大的说话按钮与字幕,没有输入框
    const talk = page.getByTestId('voice-talk');
    await expect(talk).toHaveText('说话');
    await expect(page.getByRole('textbox', { name: /^输入消息/ })).toHaveCount(0);
    await expect(page.getByTestId('voice-button')).toHaveCount(0);

    // 点一下开始,再点一下结束并发送
    await talk.click();
    await expect(talk).toHaveText('再点一下结束');
    await sleep(800);
    await talk.click();
    await expect(page.getByTestId('caption-user')).toHaveText(TRANSCRIPT);
    await expect(page.getByTestId('caption-reply')).toContainText('你好世界', { timeout: 15_000 });

    // 录音中按 Esc 取消,不发送
    const before = seen.filter((r) => r.path === '/v1/audio/transcriptions').length;
    await talk.click();
    await expect(talk).toHaveText('再点一下结束');
    await page.keyboard.press('Escape');
    await expect(talk).toHaveText('说话');
    await expect(page.getByText('已取消这次录音。')).toBeVisible();
    expect(seen.filter((r) => r.path === '/v1/audio/transcriptions')).toHaveLength(before);

    // 麦克风还在启动时按 Esc(按住中、以及点按松开后两种情况):启动完成后也不转写、不发送
    const chats = () => seen.filter((r) => r.path === '/v1/chat/completions').length;
    const chatsBefore = chats();
    await talk.hover();
    await page.mouse.down();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await talk.click();
    await page.keyboard.press('Escape');
    await sleep(1500);
    await expect(talk).toHaveText('说话');
    expect(seen.filter((r) => r.path === '/v1/audio/transcriptions')).toHaveLength(before);
    expect(chats()).toBe(chatsBefore);
    await expect(page.getByTestId('caption-user')).toHaveText(TRANSCRIPT);

    // 完整对话可以展开
    await page.getByTestId('voice-history').click();
    await expect(page.locator('.message.user').first()).toHaveText(TRANSCRIPT);
    await page.getByTestId('voice-history').click();

    // Ctrl+I 打开文字弹窗,Esc 收起且保留草稿;发送后自动收起
    chatQueue.push(...loadFixture(join(FIXTURES, 'deepseek-chat-stream.json')).interactions);
    await page.keyboard.press('Control+i');
    const popup = page.getByTestId('composer-popup');
    const box = popup.getByRole('textbox', { name: /^输入消息/ });
    await expect(box).toBeFocused();
    await box.fill('打字发一句');
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await page.getByTestId('voice-keyboard').click();
    await expect(box).toHaveValue('打字发一句');
    await popup.getByRole('button', { name: '发送' }).click();
    await expect(popup).toHaveCount(0);
    await expect(page.getByTestId('caption-user')).toHaveText('打字发一句');

    // 回复进行中,说话按钮换成「停止」,不用打开弹窗
    holdChat = true;
    await page.keyboard.press('Control+i');
    await box.fill('这一句会被停止');
    await box.press('Enter');
    const stop = page.getByTestId('voice-stop');
    await expect(stop).toBeEnabled();
    await expect(page.getByTestId('voice-talk')).toHaveCount(0);
    await stop.click();
    await expect(page.getByTestId('voice-talk')).toHaveText('说话', { timeout: 10_000 });
    await expect(stop).toHaveCount(0);
    releaseChat();
});
