// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 端到端(M1 方案第 6 节,计划 6.1):启动真实构建的 server 与一个回放 fixture 的 OpenAI 兼容假端点,
// 只用 CLI 完成初始化 → 建配置档 → 对话 → 审批,全程不打开 Web UI。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createClient } from '@fatcat-ai/client';
import { type Interaction, loadFixture } from '@fatcat-ai/eval';
import { EventEnvelope } from '@fatcat-ai/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from './io.js';
import { main } from './main.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = join(here, '../../server/dist/index.js');
const FIXTURES = join(here, '../../../packages/providers/test/fixtures');
const PASSWORD = 'correct horse battery staple';

let dir: string;
let server: ChildProcess;
let mock: Server;
let base: string;
let mockBase: string;
const queue: Interaction[] = [];
const upstreamRequests: unknown[] = [];

/** 按顺序回放排队的交互;队列空时返回 400(不会被 provider 重试),让运行明确失败。 */
function startMock(): Promise<Server> {
    const s = createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString('utf8')));
        req.on('end', () => {
            upstreamRequests.push(body ? JSON.parse(body) : null);
            const next = queue.shift();
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

async function waitHealthy(url: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(`${url}/healthz`)).ok) return;
        } catch {
            // 尚未监听
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not become healthy');
}

interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** 在本进程内运行 CLI,stdin / stdout / stderr 都是内存流(非终端)。 */
async function cli(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
    const out = new PassThrough();
    const err = new PassThrough();
    let stdout = '';
    let stderr = '';
    out.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    err.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const ctx: Ctx = {
        env: { FATCAT_AI_SERVER: base, FATCAT_AI_CLI_CONFIG: join(dir, 'cli.json'), ...options.env },
        stdin: Readable.from(options.stdin === undefined ? [] : [Buffer.from(options.stdin)]),
        stdout: out,
        stderr: err,
        onInterrupt: () => () => undefined,
    };
    const code = await main(args, ctx);
    return { code, stdout, stderr };
}

const savedToken = () => (JSON.parse(readFileSync(join(dir, 'cli.json'), 'utf8')) as { token: string }).token;
const enqueue = (name: string) => queue.push(...loadFixture(join(FIXTURES, `${name}.json`)).interactions);

beforeAll(async () => {
    expect(existsSync(SERVER_ENTRY), 'build apps/server first').toBe(true);
    dir = mkdtempSync(join(tmpdir(), 'fatcat-cli-e2e-'));
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
            FATCAT_AI_LOG_LEVEL: 'error',
            FATCAT_AI_SETUP_CODE: 'e2e-setup-code',
        },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitHealthy(base);
}, 30_000);

afterAll(async () => {
    if (server && server.exitCode === null) {
        const exited = new Promise((r) => server.once('exit', r));
        server.kill();
        await exited;
    }
    await new Promise<void>((r) => (mock ? mock.close(() => r()) : r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('CLI 端到端(不开 Web UI)', () => {
    let sessionId = '';

    it('没有令牌时直接提示登录,不发请求', async () => {
        const r = await cli(['whoami']);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain('fatcat-ai login');
    });

    it('非终端里不能交互输入密码', async () => {
        const r = await cli(['setup', '-u', 'owner']);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain('--password-stdin');
    });

    it('setup 创建主人账户并只把令牌写进配置文件', async () => {
        const r = await cli(['setup', '-u', 'owner', '--password-stdin'], { stdin: `${PASSWORD}\n` });
        expect(r.stderr).toContain('Created owner owner');
        expect(r.code).toBe(0);
        const token = savedToken();
        expect(token).toMatch(/^aip_pat_/);
        // 令牌和密码都不出现在输出里
        expect(r.stdout + r.stderr).not.toContain(token);
        expect(r.stdout + r.stderr).not.toContain(PASSWORD);
        expect(readFileSync(join(dir, 'cli.json'), 'utf8')).not.toContain(PASSWORD);
        if (process.platform !== 'win32') expect(statSync(join(dir, 'cli.json')).mode & 0o777).toBe(0o600);
        // 换令牌用的 Cookie 会话已登出,只剩一个令牌
        const client = createClient({ baseUrl: base, token });
        expect((await client.tokens.list()).items).toHaveLength(1);
    });

    it('whoami 使用保存的令牌', async () => {
        const r = await cli(['whoami']);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe(`owner @ ${base}\n`);
    });

    it('models add 拒绝明文密钥,只接受 env: / file: 引用', async () => {
        const r = await cli([
            'models',
            'add',
            '--label',
            'x',
            '--base-url',
            mockBase,
            '--model',
            'm',
            '--key-ref',
            'sk-123',
        ]);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain('env:NAME');
    });

    it('models add / list 建立指向假端点的配置档', async () => {
        const add = await cli(['models', 'add', '--label', 'mock', '--base-url', mockBase, '--model', 'deepseek-chat']);
        expect(add.code).toBe(0);
        expect(add.stdout.trim()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        const list = await cli(['models', 'list']);
        expect(list.stdout).toContain('mock');
        expect(list.stdout).toContain('not_required');
    });

    it('ask 流式输出正文到 stdout,状态到 stderr', async () => {
        enqueue('deepseek-chat-stream');
        const r = await cli(['ask', '请只回复四个字:你好世界']);
        expect(r.stderr).toMatch(/\(session [0-9A-Z]{26}\)/);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe('你好世界\n');
        sessionId = /\(session ([0-9A-Z]{26})\)/.exec(r.stderr)![1]!;
    });

    it('ask --json 每行一个 EventEnvelope,在同一会话里继续', async () => {
        enqueue('deepseek-chat-stream');
        const r = await cli(['ask', '--json', '--session', sessionId, '再说一次']);
        expect(r.code).toBe(0);
        const events = r.stdout
            .trim()
            .split('\n')
            .map((line) => EventEnvelope.parse(JSON.parse(line)));
        expect(events[0]!.event.type).toBe('run-started');
        expect(events.at(-1)!.event).toMatchObject({ type: 'run-finished', reason: 'stop' });
        // 第二轮请求里带着第一轮的历史
        const last = upstreamRequests.at(-1) as { messages: { content: string }[] };
        expect(last.messages.map((m) => m.content)).toContain('你好世界');
    });

    it('ask --stdin 从管道读入问题', async () => {
        enqueue('deepseek-chat-stream');
        const r = await cli(['ask', '--stdin'], { stdin: '管道里的问题\n' });
        expect(r.code).toBe(0);
        expect(r.stdout).toBe('你好世界\n');
    });

    it('sessions list / show 列出会话与历史', async () => {
        const list = await cli(['sessions', 'list']);
        expect(list.code).toBe(0);
        expect(list.stdout).toContain(sessionId);
        const show = await cli(['sessions', 'show', sessionId]);
        expect(show.code).toBe(0);
        expect(show.stdout).toBe(
            ['user: 请只回复四个字:你好世界', 'assistant: 你好世界', 'user: 再说一次', 'assistant: 你好世界', ''].join(
                '\n',
            ),
        );
    });

    it('非交互时需要审批的 memory.save 默认被拒绝,记忆不写入', async () => {
        // 普通事实会被条件预授权直接写入(ADR 0010 第 4 节);打开「每次都要审批」才会弹审批
        await createClient({ baseUrl: base, token: savedToken() }).settings.update({ memory: { alwaysApprove: true } });
        enqueue('memory-save-roundtrip');
        const r = await cli(['ask', '记住我住杭州']);
        expect(r.code).toBe(0);
        expect(r.stderr).toContain('[tool] memory.save');
        expect(r.stderr).toMatch(/\[approval\].*rejected/);
        expect(r.stdout).toBe('好的,我记住了。\n');
        const client = createClient({ baseUrl: base, token: savedToken() });
        expect((await client.memory.list()).items).toHaveLength(0);
    });

    it('--approve-tools 显式批准后记忆写入', async () => {
        enqueue('memory-save-roundtrip');
        const r = await cli(['ask', '--approve-tools', '记住我住杭州']);
        expect(r.code).toBe(0);
        expect(r.stderr).toMatch(/\[approval\].*approved/);
        const client = createClient({ baseUrl: base, token: savedToken() });
        const { items } = await client.memory.list();
        expect(items.map((m) => m.text)).toEqual(['用户常住杭州']);
    });

    it('memory list / search / add / edit / forget', async () => {
        const list = await cli(['memory', 'list']);
        expect(list.code).toBe(0);
        expect(list.stdout).toContain('用户常住杭州');
        const search = await cli(['memory', 'search', '杭州', '--json']);
        expect(search.code).toBe(0);
        const found = JSON.parse(search.stdout) as { id: string; text: string }[];
        expect(found.map((m) => m.text)).toEqual(['用户常住杭州']);

        const refused = await cli(['memory', 'add', '我的密钥是 sk-THISISNOTAREALKEY0123456789abcdef']);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain('Refused');

        const add = await cli(['memory', 'add', '用户喜欢喝龙井']);
        expect(add.code).toBe(0);
        const id = add.stdout.trim();
        expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect((await cli(['memory', 'edit', id, '用户喜欢喝碧螺春'])).code).toBe(0);
        expect((await cli(['memory', 'list'])).stdout).toContain('用户喜欢喝碧螺春');
        expect((await cli(['memory', 'forget', id])).code).toBe(0);
        const after = await cli(['memory', 'list', '--json']);
        expect((JSON.parse(after.stdout) as { id: string }[]).map((m) => m.id)).not.toContain(id);
    });

    it('chat 从管道逐行读取,支持 /new 与 /exit', async () => {
        enqueue('deepseek-chat-stream');
        enqueue('deepseek-chat-stream');
        const r = await cli(['chat'], { stdin: '第一句\n/new\n第二句\n/exit\n不会发送\n' });
        expect(r.code).toBe(0);
        expect(r.stdout).toBe('你好世界\n你好世界\n');
        expect(r.stderr.match(/\(session /g)).toHaveLength(2);
        expect(queue).toHaveLength(0);
    });

    it('上游出错时 ask 返回 1 并把错误写到 stderr', async () => {
        // 队列为空:假端点返回 400
        const r = await cli(['ask', 'boom']);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('error:');
        expect(r.stdout).toBe('');
    });

    it('无效令牌返回 401 并提示登录', async () => {
        const r = await cli(['whoami'], { env: { FATCAT_AI_TOKEN: 'aip_pat_invalidinvalidinvalidinvalid00' } });
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('fatcat-ai login');
    });

    it('logout 吊销令牌并删除本地配置', async () => {
        const token = savedToken();
        const r = await cli(['logout']);
        expect(r.code).toBe(0);
        expect(existsSync(join(dir, 'cli.json'))).toBe(false);
        const client = createClient({ baseUrl: base, token });
        await expect(client.auth.me()).rejects.toMatchObject({ status: 401 });
    });

    it('login 用密码重新换取令牌', async () => {
        const r = await cli(['login', '-u', 'owner', '--password-stdin'], { stdin: PASSWORD });
        expect(r.code).toBe(0);
        expect((await cli(['whoami'])).stdout).toBe(`owner @ ${base}\n`);
    });
});
