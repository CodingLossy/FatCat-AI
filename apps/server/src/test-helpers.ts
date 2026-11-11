// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 仅供测试使用(不参与构建)。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { EventBus, RunManager } from '@fatcat-ai/agent';
import { createProvider, type ModelProvider, Redactor, SecretStore } from '@fatcat-ai/providers';
import { type Connection, createRepositories, openStorage, type Repositories } from '@fatcat-ai/storage';
import type { WebFetchOptions } from '@fatcat-ai/tools';
import { createItemService, createKnowledgeBase, type KnowledgeBase } from '@fatcat-ai/items';
import { createMailComplete, createSummarizer, createToolRegistry } from './agent-setup.js';
import { type AttachmentFiles, createAttachmentFiles, createImageLoader } from './attachment-files.js';
import { createApp, type AppDeps } from './app.js';
import { createMemoryStack } from './memory-setup.js';
import { itemProviders } from './memory-provider.js';
import { createMcpControl } from './mcp-setup.js';
import { createMailService, type MailService } from './mail-setup.js';
import type { MailJobRunner } from '@fatcat-ai/mail';
import { createEmbeddingService, type EmbeddingService } from './embeddings.js';
import { FailureLimiter } from './auth/rate-limit.js';
import { createLogger } from './log.js';

export const TEST_PASSWORD = 'correct horse battery staple';
export const TEST_SETUP_CODE = 'setup-code-123456';

export interface TestServer {
    app: ReturnType<typeof createApp>;
    mail: MailService;
    bus: EventBus;
    runs: RunManager;
    embeddings: EmbeddingService;
    kb: KnowledgeBase;
    attachmentFiles: AttachmentFiles;
    dir: string;
    repos: Repositories;
    /** 测试中直接读写数据库(模拟其他客户端的修改)。 */
    conn: Connection;
    /** 本测试期间写出的全部日志行。 */
    logs: string[];
    cleanup(): Promise<void>;
}

/**
 * 真实 SQLite 文件 + 完整应用。请求头 x-test-ip 模拟 TCP 对端地址(默认 127.0.0.1)。
 */
export interface TestServerOptions {
    /** 模型请求使用的 fetch(回放或桩)。 */
    fetch?: typeof fetch;
    /** SecretStore 读取的环境变量。 */
    env?: NodeJS.ProcessEnv;
    /** 替换模型 provider(对话运行测试用)。 */
    provider?: ModelProvider;
    /** 审批请求的有效期(审批过期测试用)。 */
    approvalTimeoutMs?: number;
    /** web.fetch 的解析器与地址校验(测试中指向本机服务器)。 */
    webFetch?: WebFetchOptions;
    /** 打开 memory.write 的条件预授权(与生产一致);默认关闭,审批流程的测试每次都会弹审批。 */
    conditionalApprovals?: boolean;
    /** 邮件任务的执行方式(测试中用内存实现代替 worker 与真实服务器)。 */
    mailRunner?: MailJobRunner;
    /** 语音接口的限流与超时(ADR 0021)。 */
    voice?: AppDeps['voice'];
    /** 保存新时区后的回调(ADR 0023)。 */
    onTimeZoneChanged?: AppDeps['onTimeZoneChanged'];
}

export async function createTestServer(
    overrides: Partial<AppDeps['config']> = {},
    options: TestServerOptions = {},
): Promise<TestServer> {
    const dir = mkdtempSync(join(tmpdir(), 'fatcat-server-'));
    const { conn } = await openStorage({ dataDir: dir });
    const repos = createRepositories(conn);
    const logs: string[] = [];
    const destination = new Writable({
        write(chunk: Buffer, _enc, cb) {
            logs.push(chunk.toString('utf8'));
            cb();
        },
    });
    const redactor = new Redactor();
    const secrets = new SecretStore({ dataDir: dir, redactor, env: options.env ?? {} });
    const providerDeps = {
        secrets,
        redactor,
        sleep: () => Promise.resolve(),
        ...(options.fetch ? { fetch: options.fetch } : {}),
    };
    const providerFor = (profile: Parameters<typeof createProvider>[0]) =>
        options.provider ?? createProvider(profile, providerDeps);
    const embeddings = createEmbeddingService({ repos, providerFor, redact: (text) => redactor.redact(text) });
    // 测试中邮件任务默认不允许真的连网
    const mailRunner: MailJobRunner =
        options.mailRunner ??
        (() => Promise.reject(new Error('no mail runner in this test; pass mailRunner to createTestServer')));
    const memory = createMemoryStack(repos, embeddings);
    const kb = createKnowledgeBase({ repos, vectors: embeddings });
    const items = createItemService({
        repos,
        providers: itemProviders(),
        onSynced: (ownerId) => void kb.index(ownerId),
    });
    const bus = new EventBus();
    const attachmentFiles = createAttachmentFiles(dir);
    const runs = new RunManager({
        repos,
        bus,
        persistIntervalMs: 0,
        providerFor,
        loadImage: createImageLoader(repos, attachmentFiles),
        tools: createToolRegistry(memory, repos, items, kb, options.webFetch ? { webFetch: options.webFetch } : {}, {
            runner: mailRunner,
            secret: (ref) => secrets.resolve(ref),
            complete: createMailComplete(repos, providerFor),
        }),
        redact: (text) => redactor.redact(text),
        ...(options.approvalTimeoutMs ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
        summarize: createSummarizer(repos, providerFor),
        memoryContext: (input) => memory.context(input),
        // 审批流程的测试默认关闭条件预授权;conditionalApprovals 时与生产一致,按设置决定
        disableConditional: options.conditionalApprovals
            ? (ownerId) => repos.settings.get(ownerId).memory.alwaysApprove
            : () => true,
    });
    // MCP 子进程在 cleanup 时关闭
    const mcp = createMcpControl(runs.tools);
    const mail = createMailService({
        repos,
        secrets,
        redact: (text) => redactor.redact(text),
        runner: mailRunner,
    });
    const app = createApp({
        mcp,
        mail,
        kb,
        embeddings,
        config: {
            sourceUrl: 'https://github.com/CodingLossy/FatCat-AI',
            webDir: null,
            cookieSecure: 'auto',
            setupCode: TEST_SETUP_CODE,
            ...overrides,
        },
        repos,
        logger: createLogger({ level: 'debug', destination, redactLine: (l) => redactor.redact(l) }),
        secrets,
        providerDeps,
        bus,
        items,
        redact: (text) => redactor.redact(text),
        runs,
        memory,
        clientIp: (c) => c.req.header('x-test-ip') ?? '127.0.0.1',
        loginLimiter: new FailureLimiter(5, 60_000),
        attachmentFiles,
        ...(options.voice ? { voice: options.voice } : {}),
        ...(options.onTimeZoneChanged ? { onTimeZoneChanged: options.onTimeZoneChanged } : {}),
    });
    return {
        app,
        mail,
        bus,
        runs,
        embeddings,
        kb,
        attachmentFiles,
        dir,
        repos,
        conn,
        logs,
        async cleanup() {
            mcp.closeAll();
            await kb.idle();
            embeddings.stop();
            memory.stop();
            await embeddings.idle();
            await runs.idle();
            conn.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** 从响应中取出 Set-Cookie,拼成后续请求可用的 Cookie 头,并返回 CSRF 令牌。 */
export function sessionFrom(res: Response): { cookie: string; csrf: string; setCookies: string[] } {
    const setCookies = res.headers.getSetCookie();
    const pairs = setCookies.map((c) => c.split(';')[0]!);
    const csrf = pairs.find((p) => p.startsWith('aip_csrf='))?.slice('aip_csrf='.length) ?? '';
    return { cookie: pairs.join('; '), csrf, setCookies };
}

export const jsonBody = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
});
