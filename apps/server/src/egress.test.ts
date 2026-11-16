// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 外连运行时一致性测试(ADR 0028 第 2 节):把每一类外连各走一遍,用钩子记录真实的目的地,
// 与 GET /settings/egress-targets 双向对照。
//   正向:每个真实目的地都在清单里(防止漏列);
//   反向:清单里 enabled 且有 origin 的项必须被某条路径用到过(防止清单里留着不再使用的项)。
// 钩子见 apps/server/test/egress-hook.mjs:拦截 fetch 与 net.Socket.connect,不让任何请求真的出去。
// 邮件任务在真实的邮件子进程里跑(`--import` 预加载同一个钩子),其余在测试进程里跑。
import { fork } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ILINK_DEFAULT_BASE_URL } from '@fatcat-ai/channels';
import type { MailJob, MailJobResult, MailJobRunner } from '@fatcat-ai/mail';
import { ANTHROPIC_BASE_URL, createProvider, GEMINI_BASE_URL, Redactor, SecretStore } from '@fatcat-ai/providers';
import { EgressTargetList, type EgressTarget } from '@fatcat-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataDirMasterKey } from './data-dir.js';
import { normalizeOrigin } from './egress.js';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const HOOK = fileURLToPath(new URL('../test/egress-hook.mjs', import.meta.url));
const FAKE_MCP = fileURLToPath(new URL('../../../packages/tools/test/fake-mcp-server.mjs', import.meta.url));
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81]);

type Record = { kind: 'fetch'; url: string } | { kind: 'socket'; host: string; port: number; secure: boolean };

const DEFAULT_PORTS: { [protocol: string]: string } = {
    'http:': '80',
    'https:': '443',
    'imap:': '143',
    'imaps:': '993',
    'smtp:': '25',
    'smtps:': '465',
};

/** 目的地的比较键:是否一开始就加密 + 主机 + 端口。STARTTLS 的升级发生在已建立的连接上,所以 imap/smtp 记为明文。 */
function keyOfOrigin(origin: string): string {
    const url = new URL(origin);
    const secure = ['https:', 'imaps:', 'smtps:'].includes(url.protocol);
    return `${secure ? 'tls' : 'plain'}://${url.hostname}:${url.port || DEFAULT_PORTS[url.protocol]}`;
}

function keyOfRecord(record: Record): string {
    if (record.kind === 'socket') return `${record.secure ? 'tls' : 'plain'}://${record.host}:${record.port}`;
    return keyOfOrigin(normalizeOrigin(record.url)!);
}

/** 在子进程里跑邮件任务(与服务器的 runInWorker 相同的启动方式),并用 --import 装上钩子。 */
function hookedMailRunner(log: string): MailJobRunner {
    const worker = join(dirname(createRequire(import.meta.url).resolve('@fatcat-ai/mail')), 'worker.js');
    expect(existsSync(worker), 'build @fatcat-ai/mail first (pnpm build)').toBe(true);
    return <J extends MailJob>(job: J) =>
        new Promise<MailJobResult<J>>((resolve, reject) => {
            const child = fork(worker, [], {
                execArgv: ['--import', pathToFileURL(HOOK).href],
                env: { PATH: process.env.PATH ?? '', EGRESS_LOG: log },
                stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
                serialization: 'advanced',
            });
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error('mail worker did not finish'));
            }, 30_000);
            child.on('message', (m: { ok: true; result: MailJobResult<J> } | { ok: false; error: string }) => {
                clearTimeout(timer);
                if (m.ok) resolve(m.result);
                else reject(new Error(m.error));
            });
            child.on('error', reject);
            child.on('exit', () => clearTimeout(timer));
            child.send(job);
        });
}

const seen: Record[] = [];
let uninstall: (() => void) | null = null;
let s: TestServer | null = null;
const mailLog = join(tmpdir(), `fatcat-egress-${process.pid}.log`);

beforeEach(async () => {
    seen.length = 0;
    const hook = (await import(pathToFileURL(HOOK).href)) as { install(sink: (r: Record) => void): () => void };
    uninstall = hook.install((record) => seen.push(record));
});

afterEach(async () => {
    uninstall?.();
    uninstall = null;
    rmSync(mailLog, { force: true });
    await s?.cleanup();
    s = null;
});

describe('egress targets match the real outbound destinations', () => {
    it('every real destination is listed, and every enabled listed origin is actually used', async () => {
        const env = { KEY: 'sk-test-key', MAIL_PW: 'mail-pw', WECHAT_TOKEN: 'wechat-token' };
        s = await createTestServer(
            {},
            {
                env,
                mailRunner: hookedMailRunner(mailLog),
                // 与生产一致:渠道由真实的微信适配器运行(工厂在服务器创建之后才可用)
                channelAdapters: { wechat: (channel) => s!.wechat.factory(channel) },
            },
        );
        const setup = await s.app.request(
            '/api/v1/auth/setup',
            jsonBody({ username: 'owner', password: TEST_PASSWORD }),
        );
        const { cookie, csrf } = sessionFrom(setup);
        const req = (path: string, init: RequestInit = {}) =>
            s!.app.request(path, {
                ...init,
                headers: {
                    cookie,
                    'X-CSRF-Token': csrf,
                    'content-type': 'application/json',
                    ...(init.headers as { [k: string]: string } | undefined),
                },
            });
        const send = (method: string, path: string, body?: unknown) =>
            req(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const create = async (path: string, body: unknown) => {
            const res = await send('POST', path, body);
            expect(res.status).toBe(201);
            return ((await res.json()) as { id: string }).id;
        };

        // —— 配置:每一类外连至少一项 ——
        const profile = (over: { [k: string]: unknown }) =>
            create('/api/v1/models', {
                label: 'p',
                kind: 'openai-compatible',
                baseURL: 'https://chat.example.test/v1?token=hidden',
                apiKeyRef: 'env:KEY',
                model: 'm',
                purpose: ['chat'],
                ...over,
            });
        const chatId = await profile({});
        const anthropicId = await profile({ kind: 'anthropic', baseURL: undefined });
        const geminiId = await profile({ kind: 'gemini', baseURL: undefined, purpose: ['cheap'] });
        const embedId = await profile({ baseURL: 'https://embed-a.example.test/v1', model: 'e', purpose: ['embed'] });
        await profile({ baseURL: 'https://embed-b.example.test/v1', model: 'e2', purpose: ['embed'] }); // 没被选中
        await profile({ baseURL: 'https://stt.example.test/v1', model: 'stt', purpose: ['stt'] });
        await profile({
            baseURL: 'https://tts.example.test/v1',
            model: 'tts',
            purpose: ['tts'],
            params: { voice: 'v' },
        });

        const account = (host: string, security: 'tls' | 'starttls', imapPort: number, smtpPort: number) => ({
            label: host,
            address: 'me@example.test',
            username: 'me@example.test',
            passwordRef: 'env:MAIL_PW',
            imap: { host: `imap.${host}`, port: imapPort, security },
            smtp: { host: `smtp.${host}`, port: smtpPort, security },
        });
        const tlsMail = await create('/api/v1/mail/accounts', account('tls.example.test', 'tls', 993, 465));
        const plainMail = await create('/api/v1/mail/accounts', account('start.example.test', 'starttls', 143, 587));
        const idleMail = await create('/api/v1/mail/accounts', account('idle.example.test', 'tls', 993, 465));
        expect((await send('PATCH', `/api/v1/mail/accounts/${idleMail}`, { enabled: false })).status).toBe(200);

        const ownerId = s.repos.owners.ids()[0]!;
        const wechat = s.repos.channels.create(ownerId, {
            kind: 'wechat',
            label: 'default',
            config: { tokenRef: 'env:WECHAT_TOKEN' },
        });
        const wechatAlt = s.repos.channels.create(ownerId, {
            kind: 'wechat',
            label: 'custom host',
            config: { tokenRef: 'env:WECHAT_TOKEN', baseUrl: 'https://ilink-alt.example.test' },
        });

        const mcpRes = await send('POST', '/api/v1/mcp/servers', {
            name: 'fake',
            command: process.execPath,
            args: [FAKE_MCP],
        });
        expect(mcpRes.status).toBe(201);

        // —— 清单 ——
        const listRes = await send('GET', '/api/v1/settings/egress-targets');
        expect(listRes.status).toBe(200);
        const targets = EgressTargetList.parse(await listRes.json()).targets;
        const categories = new Set(targets.map((t) => t.category));
        for (const category of ['model', 'embedding', 'voice', 'mail', 'channel', 'mcp'] as const) {
            expect(categories, `category ${category} should be configured by this test`).toContain(category);
        }
        // 没有配置过的类别不能凭空出现(当前代码里没有更新检查,也没有插件)
        expect(categories).not.toContain('update-check');
        expect(categories).not.toContain('plugin');

        // —— 驱动:每一类外连走真实的代码路径 ——
        // 模型:连接测试(openai 兼容、Anthropic 默认地址、Gemini 默认地址)
        for (const id of [chatId, anthropicId, geminiId]) {
            expect((await send('POST', `/api/v1/models/${id}/test`)).status).toBe(200);
        }
        // 嵌入:真实 provider 的 embed()(嵌入队列用的也是它)
        const redactor = new Redactor();
        const secrets = new SecretStore({ dataDir: s.dir, redactor, env, masterKey: dataDirMasterKey(s.dir, env) });
        const embedProfile = s.repos.modelProfiles.get(ownerId, embedId)!;
        await createProvider(embedProfile, { secrets, redactor, sleep: () => Promise.resolve() })
            .embed?.(['hello'])
            .catch(() => undefined);
        // 语音:转写与朗读
        const form = new FormData();
        form.append('file', new File([WEBM as Uint8Array<ArrayBuffer>], 'voice.webm', { type: 'audio/webm' }));
        const stt = await s.app.request('/api/v1/voice/transcriptions', {
            method: 'POST',
            body: form,
            headers: { cookie, 'X-CSRF-Token': csrf },
        });
        expect(stt.status).not.toBe(401);
        expect((await send('POST', '/api/v1/voice/speech', { text: 'hi' })).status).not.toBe(401);
        // 邮件:连接测试在邮件子进程里跑(IMAP + SMTP;TLS 与 STARTTLS 各一个账户)
        for (const id of [tlsMail, plainMail]) {
            expect((await send('POST', `/api/v1/mail/accounts/${id}/test`)).status).toBe(200);
        }
        // 微信:扫码登录请求二维码(默认地址),并启用两个渠道,让真实适配器轮询各自的地址
        expect((await send('POST', `/api/v1/channels/${wechat.id}/wechat/login`)).status).toBe(502);
        for (const channel of [wechat, wechatAlt]) {
            expect((await send('PATCH', `/api/v1/channels/${channel.id}`, { enabled: true })).status).toBe(200);
        }
        await waitFor(() => seen.some((r) => r.kind === 'fetch' && r.url.startsWith('https://ilink-alt.example.test')));
        await s.channels.stopAll();

        // 子进程的记录与测试进程的记录合并
        const fromWorkers = existsSync(mailLog)
            ? readFileSync(mailLog, 'utf8')
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => JSON.parse(line) as Record)
            : [];
        const used = new Set([...seen, ...fromWorkers].map(keyOfRecord));
        expect(fromWorkers.length, 'the mail worker should have reported its connections').toBeGreaterThan(0);

        // —— 对照 ——
        const listed = new Map<string, EgressTarget[]>();
        for (const target of targets) {
            if (target.origin === null) continue;
            const key = keyOfOrigin(target.origin);
            listed.set(key, [...(listed.get(key) ?? []), target]);
        }
        // 正向:真实目的地都在清单里
        const unlisted = [...used].filter((key) => !listed.has(key));
        expect(unlisted, 'real destinations missing from the egress list').toEqual([]);
        // 反向:清单里 enabled 的项都被用到过
        const unused = targets.filter((t) => t.enabled && t.origin !== null && !used.has(keyOfOrigin(t.origin)));
        expect(
            unused.map((t) => t.id),
            'enabled list entries that nothing used',
        ).toEqual([]);

        // 清单里的特殊项如实标注:停用的账户、没被选中的嵌入档仍列出但没被用到
        const byId = new Map(targets.map((t) => [t.id, t]));
        expect(byId.get(`mail:${idleMail}:imap`)).toMatchObject({ enabled: false });
        expect(used.has('tls://imap.idle.example.test:993')).toBe(false);
        const embedB = targets.find((t) => t.category === 'embedding' && t.origin === 'https://embed-b.example.test');
        expect(embedB).toMatchObject({ enabled: false });
        expect(used.has('tls://embed-b.example.test:443')).toBe(false);
        // 默认地址的两个没写 baseURL 的配置档与微信默认地址确实被访问
        for (const base of [ANTHROPIC_BASE_URL, GEMINI_BASE_URL, ILINK_DEFAULT_BASE_URL]) {
            expect(used.has(keyOfOrigin(normalizeOrigin(base)!)), base).toBe(true);
        }
        // stdio MCP 是本地进程:没有 origin,标注 local,其自身的外连不在清单内
        expect(targets.find((t) => t.category === 'mcp')).toMatchObject({ local: true, origin: null });
        // 清单与记录里都不含路径、查询与凭据
        expect(JSON.stringify(targets)).not.toMatch(/hidden|sk-test-key|mail-pw|wechat-token/);
    }, 60_000);
});

/** 轮询等待条件成立(渠道在后台启动)。 */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the channels to start polling');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
