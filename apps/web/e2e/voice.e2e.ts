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
/** 依次作为转写结果返回;用完后返回 TRANSCRIPT。 */
const transcripts: string[] = [];
/** 朗读返回的音频时长(秒);测「朗读时打断」时调长。 */
let speechSeconds = 0.6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 440 Hz 的 16 位单声道 WAV(合成),默认 0.6 秒。 */
function toneWav(seconds = speechSeconds): Buffer {
    const rate = 8000;
    const samples = Math.round(rate * seconds);
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
                res.end(JSON.stringify({ text: transcripts.shift() ?? TRANSCRIPT }));
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
    await expect(page.locator('.wb-shell')).toBeVisible();

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
    await page.goto(base); // 新对话;语音优先时侧栏收在 logo 里
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
    await expect(page.locator('.wb-shell')).toBeVisible();
    const csrf = (await page.context().cookies()).find((c) => c.name === 'aip_csrf')!.value;
    const res = await page.request.fetch(`${base}/api/v1/settings`, {
        method: 'PUT',
        // 这条用例测点按说话;连续语音(默认开着)在下一条用例里测
        data: { voice: { autoSpeak: false, inputMode: 'voice', continuous: false } },
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
    await page.goto(base); // 新对话;语音优先时侧栏收在 logo 里

    // 主界面只有球和下面三行字,没有输入框和按钮(ADR 0049 第 10 节);球本身就是说话的地方
    const talk = page.getByTestId('voice-talk');
    await expect(talk).toHaveAttribute('aria-label', /^点一下开始说话/);
    await expect(page.getByTestId('voice-keyboard')).toHaveCount(0);
    await expect(page.getByTestId('voice-history')).toHaveCount(0);
    await expect(page.locator('.wb-capsule')).toBeHidden();
    await expect(page.getByTestId('wb-logo')).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^输入消息/ })).toHaveCount(0);
    await expect(page.getByTestId('voice-button')).toHaveCount(0);

    // 点一下开始,再点一下结束并发送
    await talk.click();
    await expect(talk).toHaveAttribute('aria-label', '再点一下结束');
    await expect(page.getByTestId('voice-status')).toHaveText('FatCat 正在聆听');
    await sleep(800);
    await talk.click();
    await expect(page.getByTestId('voice-caption')).toContainText('你好世界', { timeout: 15_000 });

    // 录音中按 Esc 取消,不发送
    const before = seen.filter((r) => r.path === '/v1/audio/transcriptions').length;
    await talk.click();
    await expect(talk).toHaveAttribute('aria-label', '再点一下结束');
    await page.keyboard.press('Escape');
    await expect(talk).toHaveAttribute('aria-label', /^点一下开始说话/);
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
    await expect(talk).toHaveAttribute('aria-label', /^点一下开始说话/);
    expect(seen.filter((r) => r.path === '/v1/audio/transcriptions')).toHaveLength(before);
    expect(chats()).toBe(chatsBefore);

    // 完整对话用 Ctrl+H 展开,里面有「收起」
    await page.keyboard.press('Control+h');
    await expect(page.locator('.message.user').first()).toHaveText(TRANSCRIPT);
    await page.getByTestId('voice-history').click();
    await expect(page.getByTestId('voice-stage')).toBeVisible();

    // Ctrl+I 打开文字弹窗,Esc 收起且保留草稿;发送后自动收起
    chatQueue.push(...loadFixture(join(FIXTURES, 'deepseek-chat-stream.json')).interactions);
    await page.keyboard.press('Control+i');
    const popup = page.getByTestId('composer-popup');
    const box = popup.getByRole('textbox', { name: /^输入消息/ });
    await expect(box).toBeFocused();
    await box.fill('打字发一句');
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await page.keyboard.press('Control+i');
    await expect(box).toHaveValue('打字发一句');
    await popup.getByRole('button', { name: '发送' }).click();
    await expect(popup).toHaveCount(0);
    await expect(page.getByTestId('voice-caption')).toContainText('你好世界', { timeout: 15_000 });
    await page.keyboard.press('Control+h');
    await expect(page.locator('.message.user').last()).toHaveText('打字发一句');
    await page.keyboard.press('Control+h');

    // 回复进行中,点球就是停止,不用打开弹窗
    holdChat = true;
    await page.keyboard.press('Control+i');
    await box.fill('这一句会被停止');
    await box.press('Enter');
    const stop = page.getByTestId('voice-stop');
    await expect(stop).toBeEnabled();
    await expect(page.getByTestId('voice-talk')).toHaveCount(0);
    await stop.click();
    await expect(page.getByTestId('voice-talk')).toHaveAttribute('aria-label', /^点一下开始说话/, { timeout: 10_000 });
    await expect(stop).toHaveCount(0);
    releaseChat();
});

test('连续对话:本地断句、朗读时打断、静音与后台自动结束(ADR 0049 第 2 节)', async ({ page }) => {
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.locator('.wb-shell')).toBeVisible();
    const csrf = (await page.context().cookies()).find((c) => c.name === 'aip_csrf')!.value;
    const res = await page.request.fetch(`${base}/api/v1/settings`, {
        method: 'PUT',
        data: { voice: { autoSpeak: false, inputMode: 'voice', continuous: true, silenceEndSeconds: 3 } },
        headers: { 'x-csrf-token': csrf },
    });
    expect(res.ok()).toBe(true);
    const cancels: string[] = [];
    page.on('request', (r) => {
        if (/\/runs\/[^/]+\/cancel/.test(r.url())) cancels.push(r.url());
    });

    // 可控的假麦克风:一个振荡器,增益 0 是安静,打开增益就是「在说话」。每次打开麦克风给一条新的流
    await page.addInitScript(() => {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        osc.frequency.value = 300;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        osc.start();
        const constraints: unknown[] = [];
        // 记下朗读用的每个 <audio>,用来确认打断时真的停了
        const played: HTMLMediaElement[] = [];
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            played.push(this);
            return play.call(this);
        };
        Object.assign(window, {
            fakeMic: {
                constraints,
                played: () => played.map((a) => ({ paused: a.paused, ended: a.ended, at: a.currentTime })),
                on: () => (gain.gain.value = 0.8),
                off: () => (gain.gain.value = 0),
            },
        });
        navigator.mediaDevices.getUserMedia = async (c) => {
            constraints.push(c);
            await ctx.resume();
            const dest = ctx.createMediaStreamDestination();
            gain.connect(dest);
            return dest.stream;
        };
    });
    const say = async (ms: number) => {
        await page.evaluate(() => (window as unknown as { fakeMic: { on(): void } }).fakeMic.on());
        await sleep(ms);
        await page.evaluate(() => (window as unknown as { fakeMic: { off(): void } }).fakeMic.off());
    };
    await page.reload();
    await page.goto(base); // 新对话;语音优先时侧栏收在 logo 里

    const conversation = page.getByTestId('voice-conversation');
    await expect(page.getByTestId('voice-talk')).toHaveCount(0);
    const indicator = page.getByTestId('voice-indicator');
    const transcriptions = () => seen.filter((r) => r.path === '/v1/audio/transcriptions').length;
    const sttBefore = transcriptions();
    transcripts.push('第一句', '第二句');
    chatQueue.push(...loadFixture(join(FIXTURES, 'deepseek-chat-stream.json')).interactions);
    chatQueue.push(...loadFixture(join(FIXTURES, 'deepseek-chat-stream.json')).interactions);
    speechSeconds = 6;

    // 连续语音默认开着、麦克风已授权:主界面一打开就开始聆听,不用点球(ADR 0049 第 10.3 节)
    // 顶部和页面标题都标出「麦克风开着」;打开麦克风时要求回声消除与降噪
    await expect(page.getByTestId('mic-on')).toContainText('麦克风开着');
    await expect(conversation).toHaveAttribute('aria-label', '暂停聆听');
    // 点球暂停,再点继续
    await conversation.click();
    await expect(page.getByTestId('mic-on')).toHaveCount(0);
    await expect(conversation).toHaveAttribute('aria-label', '继续聆听');
    await conversation.click();
    await expect(page.getByTestId('mic-on')).toBeVisible();
    await expect(page).toHaveTitle(/^\[麦克风开着\]/);
    // 对话开着、没检测到说话:状态是「正在聆听」
    await expect(page.getByTestId('voice-status')).toHaveText('FatCat 正在聆听');
    expect(
        await page.evaluate(() => (window as unknown as { fakeMic: { constraints: unknown[] } }).fakeMic.constraints),
    ).toEqual([
        { audio: { echoCancellation: true, noiseSuppression: true } },
        { audio: { echoCancellation: true, noiseSuppression: true } },
    ]);

    // 很短的声音(咳嗽)不算说话,不转写
    await sleep(500);
    await say(100);
    await sleep(1200);
    expect(transcriptions()).toBe(sttBefore);

    // 第一段:说完停顿后自动结束并发送;回复读出来
    await say(700);
    await expect(page.getByTestId('voice-caption')).toContainText('你好世界', { timeout: 15_000 });
    await expect(indicator).toHaveAttribute('data-state', 'speaking', { timeout: 10_000 });
    // 连续对话里回复朗读中:状态行写「正在说话」,球是说话的颜色(ADR 0049 第 10.4 节)
    await expect(page.getByTestId('voice-status')).toHaveText('FatCat 正在说话');
    await expect(indicator).toHaveAttribute('data-hero', 'speaking');

    // 朗读时开口:立即停止朗读(6 秒的音频没读完),不取消运行,这一段作为下一条消息发送
    speechSeconds = 0.6;
    await page.evaluate(() => (window as unknown as { fakeMic: { on(): void } }).fakeMic.on());
    await expect(indicator).toHaveAttribute('data-state', 'listening', { timeout: 1500 });
    // 检测到说话:状态行与球都换成「检测到语音」
    await expect(page.getByTestId('voice-status')).toHaveText('检测到语音');
    await expect(indicator).toHaveAttribute('data-hero', 'heard');
    const played = await page.evaluate(() =>
        (
            window as unknown as { fakeMic: { played(): { paused: boolean; ended: boolean; at: number }[] } }
        ).fakeMic.played(),
    );
    expect(played).toHaveLength(1);
    expect(played[0]).toMatchObject({ paused: true, ended: false });
    expect(played[0]!.at).toBeLessThan(5);
    await sleep(500);
    await page.evaluate(() => (window as unknown as { fakeMic: { off(): void } }).fakeMic.off());
    await expect.poll(transcriptions, { timeout: 10_000 }).toBe(sttBefore + 2);
    await expect(page.getByTestId('voice-caption')).toContainText('你好世界', { timeout: 15_000 });
    expect(cancels).toEqual([]);

    // 之后 3 秒没人说话(朗读与等回复的时间不算):自动结束,麦克风关闭
    await expect(page.getByTestId('mic-on')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('一直没听到说话,已暂停聆听。')).toBeVisible();
    await expect(conversation).toHaveAttribute('aria-label', '继续聆听');
    await expect(page).toHaveTitle(/^FatCat-AI/);

    // 页面进入后台:立即结束
    await conversation.click();
    await expect(page.getByTestId('mic-on')).toBeVisible();
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByTestId('mic-on')).toHaveCount(0);
    await expect(page.getByText('页面切到了后台,已暂停聆听,麦克风已关闭。')).toBeVisible();
    // 回到前台:因为切后台而暂停的,自动恢复聆听
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByTestId('mic-on')).toBeVisible();

    // 回复进行中点球只停止这次回复,对话继续;之后 Esc 暂停聆听
    transcripts.push('第三句');
    holdChat = true;
    await say(700);
    const stopOrb = page.getByTestId('voice-stop');
    await expect(stopOrb).toHaveAttribute('aria-label', '停止', { timeout: 10_000 });
    await expect(stopOrb).toBeEnabled();
    await stopOrb.click();
    await expect.poll(() => cancels.length, { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId('mic-on')).toBeVisible();
    releaseChat();
    await expect(conversation).toHaveAttribute('aria-label', '暂停聆听', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('mic-on')).toHaveCount(0);
    // 用户暂停过:刷新之前不再自动打开
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await sleep(500);
    await expect(page.getByTestId('mic-on')).toHaveCount(0);
    expect(transcriptions()).toBe(sttBefore + 3);
});

test('极简主界面:三套主题的空闲 / 聆听 / 思考,手机不横向溢出(ADR 0049 第 10 节)', async ({ page }) => {
    const shots = process.env.FATCAT_SHOTS_DIR;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.locator('.wb-shell')).toBeVisible();
    const csrf = (await page.context().cookies()).find((c) => c.name === 'aip_csrf')!.value;
    const put = async (data: unknown) =>
        expect(
            (
                await page.request.fetch(`${base}/api/v1/settings`, {
                    method: 'PUT',
                    data,
                    headers: { 'x-csrf-token': csrf },
                })
            ).ok(),
        ).toBe(true);
    await put({ voice: { autoSpeak: false, inputMode: 'voice', continuous: false } });

    for (const theme of ['tech', 'nature', 'cat']) {
        await put({ theme });
        await page.goto(base);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const talk = page.getByTestId('voice-talk');
        await expect(talk).toBeVisible();
        // 主界面上没有胶囊、代理下拉、说话 / 打字按钮和「查看完整对话」
        await expect(page.locator('.wb-capsule')).toBeHidden();
        await expect(page.locator('.wb-side')).toBeHidden();
        await expect(page.getByTestId('agent-picker')).toHaveCount(0);
        await expect(page.getByTestId('voice-status')).toHaveText('FatCat');
        await page.waitForTimeout(400);
        if (shots) await page.screenshot({ path: join(shots, `${theme}-idle.png`) });

        await talk.click();
        await expect(page.getByTestId('voice-status')).toHaveText('FatCat 正在聆听');
        await page.waitForTimeout(400);
        if (shots) await page.screenshot({ path: join(shots, `${theme}-listening.png`) });
        await page.keyboard.press('Escape');

        holdChat = true;
        chatQueue.push(...loadFixture(join(FIXTURES, 'deepseek-chat-stream.json')).interactions);
        await page.keyboard.press('Control+i');
        await page.getByTestId('composer-popup').getByRole('textbox').fill('今天天气怎么样?');
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('voice-status')).toHaveText('FatCat 正在思考');
        await page.waitForTimeout(400);
        if (shots) await page.screenshot({ path: join(shots, `${theme}-thinking.png`) });
        releaseChat();
        await expect(page.getByTestId('voice-caption')).toContainText('你好世界', { timeout: 15_000 });
        if (shots) await page.screenshot({ path: join(shots, `${theme}-reply.png`) });

        // 左上角的小圆 logo 打开原来的侧栏
        await page.getByTestId('wb-logo').click();
        await expect(page.locator('.wb-side')).toBeVisible();
        await page.waitForTimeout(300); // 抽屉滑入的动画
        if (shots && theme === 'tech') await page.screenshot({ path: join(shots, 'tech-menu.png') });
        await page.keyboard.press('Escape');
        await expect(page.locator('.wb-side')).toBeHidden();
    }

    // 命令面板里能切换模型和代理
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('切换模型');
    await expect(page.getByRole('option', { name: /^切换模型:/ }).first()).toBeVisible();
    await page.keyboard.press('Escape');

    await put({ theme: 'tech' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await expect(page.getByTestId('voice-talk')).toBeVisible();
    await expect(page.locator('.wb-tabs')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.waitForTimeout(400);
    if (shots) await page.screenshot({ path: join(shots, 'phone-idle.png') });
});

test('连续语音默认开着、球的状态色:三套主题的聆听 / 检测到语音 / 空闲 / 思考 / 说话;手机长按球打字、上滑看完整对话(ADR 0049 第 10.3、10.4 节)', async ({
    browser,
}) => {
    const shots = process.env.FATCAT_SHOTS_DIR;
    const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    // 可控的假麦克风:平时增益 0(安静),fakeMic.on() 时像在说话
    await page.addInitScript(() => {
        const gains: GainNode[] = [];
        Object.assign(window, {
            fakeMic: {
                on: () => gains.forEach((g) => (g.gain.value = 0.8)),
                off: () => gains.forEach((g) => (g.gain.value = 0)),
            },
        });
        navigator.mediaDevices.getUserMedia = async () => {
            const ctx = new AudioContext();
            await ctx.resume();
            const osc = ctx.createOscillator();
            osc.frequency.value = 300;
            const gain = ctx.createGain();
            gain.gain.value = 0;
            gains.push(gain);
            osc.connect(gain);
            osc.start();
            const dest = ctx.createMediaStreamDestination();
            gain.connect(dest);
            return dest.stream;
        };
    });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.locator('.wb-shell')).toBeVisible();
    const csrf = (await context.cookies()).find((c) => c.name === 'aip_csrf')!.value;
    const put = async (data: unknown) =>
        expect(
            (
                await page.request.fetch(`${base}/api/v1/settings`, {
                    method: 'PUT',
                    data,
                    headers: { 'x-csrf-token': csrf },
                })
            ).ok(),
        ).toBe(true);
    // 前面的用例关掉过连续语音;默认值(开着)由 packages/shared 的单测覆盖。朗读打开,用来拍「说话」
    await put({ voice: { autoSpeak: true, inputMode: 'voice', continuous: true, silenceEndSeconds: 60 } });
    const indicator = page.getByTestId('voice-indicator');
    const status = page.getByTestId('voice-status');
    const shot = async (name: string) => {
        await page.waitForTimeout(600); // 状态色过渡
        if (shots) await page.screenshot({ path: join(shots, name) });
    };

    for (const theme of ['tech', 'nature', 'cat']) {
        await put({ theme });
        await page.goto(base);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        // 一打开就在听:顶部有「麦克风开着」,球的动作是暂停,球是聆听色
        await expect(page.getByTestId('mic-on')).toBeVisible();
        await expect(page.getByTestId('voice-conversation')).toHaveAttribute('aria-label', '暂停聆听');
        await expect(status).toHaveText('FatCat 正在聆听');
        await expect(indicator).toHaveAttribute('data-hero', 'listening');
        await shot(`${theme}-listening.png`);

        // 检测到语音:亮绿;然后 Esc 暂停(这一段丢掉,不发去转写)
        await page.evaluate(() => (window as unknown as { fakeMic: { on(): void } }).fakeMic.on());
        await expect(status).toHaveText('检测到语音');
        await expect(indicator).toHaveAttribute('data-hero', 'heard');
        await shot(`${theme}-heard.png`);
        await page.keyboard.press('Escape');
        await page.evaluate(() => (window as unknown as { fakeMic: { off(): void } }).fakeMic.off());
        await expect(page.getByTestId('mic-on')).toHaveCount(0);
        await expect(status).toHaveText('FatCat');
        await expect(indicator).toHaveAttribute('data-hero', 'idle');
        await shot(`${theme}-idle.png`);

        // 思考:紫色、换一种转法
        holdChat = true;
        speechSeconds = 8;
        chatQueue.push(...loadFixture(join(FIXTURES, 'deepseek-chat-stream.json')).interactions);
        await page.keyboard.press('Control+i');
        await page.getByTestId('composer-popup').getByRole('textbox').fill('今天天气怎么样?');
        await page.keyboard.press('Enter');
        await expect(status).toHaveText('FatCat 正在思考');
        await expect(indicator).toHaveAttribute('data-hero', 'thinking');
        await shot(`${theme}-thinking.png`);

        // 说话:深亮蓝,粒子随朗读音量向外脉动
        releaseChat();
        await expect(status).toHaveText('FatCat 正在说话', { timeout: 15_000 });
        await expect(indicator).toHaveAttribute('data-hero', 'speaking');
        await shot(`${theme}-speaking.png`);
        await page.keyboard.press('Escape');
    }
    speechSeconds = 0.6;
    await put({ theme: 'tech' });
    const cookies = await context.cookies();
    await context.close();

    // 手机:长按球打开文字弹窗(不暂停聆听),上滑打开完整对话
    const phone = await browser.newContext({
        permissions: ['microphone'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
    });
    await phone.addCookies(cookies);
    const mobile = await phone.newPage();
    await mobile.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = async () => {
            const ctx = new AudioContext();
            await ctx.resume();
            const dest = ctx.createMediaStreamDestination();
            return dest.stream;
        };
    });
    await mobile.goto(base);
    const orb = mobile.getByTestId('voice-conversation');
    await expect(mobile.getByTestId('mic-on')).toBeVisible();
    const box = (await orb.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await phone.newCDPSession(mobile);
    const touchAt = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });

    // 长按约 0.7 秒:弹出文字输入框,聆听不受影响
    await touchAt('touchStart', cx, cy);
    await mobile.waitForTimeout(700);
    await touchAt('touchEnd', cx, cy);
    await expect(mobile.getByTestId('composer-popup')).toBeVisible();
    await expect(mobile.getByTestId('mic-on')).toBeVisible();
    await expect(orb).toHaveAttribute('aria-label', '暂停聆听');
    await mobile.waitForTimeout(300);
    if (shots) await mobile.screenshot({ path: join(shots, 'phone-long-press.png') });
    await mobile.getByTestId('composer-popup').getByRole('button', { name: '收起' }).click();
    await expect(mobile.getByTestId('composer-popup')).toHaveCount(0);

    // 轻点一下仍是暂停 / 继续
    await mobile.touchscreen.tap(cx, cy);
    await expect(mobile.getByTestId('mic-on')).toHaveCount(0);
    await mobile.touchscreen.tap(cx, cy);
    await expect(mobile.getByTestId('mic-on')).toBeVisible();

    // 从球下方往上滑:打开完整对话,里面有「收起」
    await touchAt('touchStart', cx, cy + box.height / 2 + 80);
    for (let i = 1; i <= 5; i++) await touchAt('touchMove', cx, cy + box.height / 2 + 80 - i * 40);
    await touchAt('touchEnd', cx, cy + box.height / 2 - 120);
    await expect(mobile.getByTestId('voice-history')).toBeVisible();
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mobile.waitForTimeout(300);
    if (shots) await mobile.screenshot({ path: join(shots, 'phone-history.png') });
    await mobile.getByTestId('voice-history').click();
    await expect(mobile.getByTestId('voice-conversation')).toBeVisible();
    await phone.close();
});
