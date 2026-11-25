// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 仅供测试使用(不参与构建)。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { EventBus, RunManager } from '@fatcat-ai/agent';
import { createProvider, type ModelProvider, Redactor, SecretStore } from '@fatcat-ai/providers';
import {
    backupDatabase,
    type Connection,
    createRepositories,
    openStorage,
    type Repositories,
} from '@fatcat-ai/storage';
import type { BrowserToolOptions, WebFetchOptions } from '@fatcat-ai/tools';
import { createItemService, createKnowledgeBase, type KnowledgeBase } from '@fatcat-ai/items';
import { createChannelPushTool } from './scheduler/channel-push-tool.js';
import { ClientCalls, createClientBrowserHost, createClientOpenHost } from './client-calls.js';
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
import { dataDirMasterKey } from './data-dir.js';
import { type BuiltinSkill, SkillService } from './skills.js';
import { createLogger } from './log.js';
import { type AdapterFactory, ChannelHub, QqChannels, WechatChannels } from '@fatcat-ai/channels/hub';
import { channelHubServerDeps } from './channel-setup.js';
import { PluginService } from '@fatcat-ai/plugins';
import { SERVER_VERSION } from './version.js';
import type { AgentEvent, ChannelKind } from '@fatcat-ai/shared';
import { createDelegateTool, groupOf, isCoreGroup } from '@fatcat-ai/tools';
import type { ChatChunk } from '@fatcat-ai/providers';
import { resolveDelegateAgent } from './routes/agents.js';
import { ownerSecrets } from './member-secrets.js';

/**
 * 按需工具组(ADR 0047 第 1 节):脚本里调用的工具不在核心组时,在同一步里先调 tools.enable 开启它的组
 * (同一步的调用按顺序执行,开启后紧接着的调用就可用)。工具结果里多出的 tools.enable 由 isEnableResult 过滤。
 */
export function* enableGroupFor(name: string, callId: string): Generator<ChatChunk> {
    // git.* 与 code.run 显式归入按需组 code(ADR 0049 第 3.2 节)
    const group = name.startsWith('git.') ? 'code' : groupOf(name);
    if (isCoreGroup(group)) return;
    yield { type: 'tool-call', callId: `${callId}-enable`, name: 'tools.enable', input: { group } };
}

/** 去掉 tools.enable 的调用结果,只留脚本里目标工具的结果(配合 enableGroupFor)。 */
export function toolResultsOf(events: readonly AgentEvent[]): Extract<AgentEvent, { type: 'tool-result' }>[] {
    const enables = new Set(
        events.flatMap((e) => (e.type === 'tool-call' && e.name === 'tools.enable' ? [e.callId] : [])),
    );
    return events.filter(
        (e): e is Extract<AgentEvent, { type: 'tool-result' }> => e.type === 'tool-result' && !enables.has(e.callId),
    );
}

export const TEST_PASSWORD = 'correct horse battery staple';
export const TEST_SETUP_CODE = 'setup-code-123456';

export interface TestServer {
    app: ReturnType<typeof createApp>;
    mail: MailService;
    bus: EventBus;
    runs: RunManager;
    channels: ChannelHub;
    embeddings: EmbeddingService;
    kb: KnowledgeBase;
    attachmentFiles: AttachmentFiles;
    dir: string;
    /** 测试直接读写 secrets(模拟渠道写入的键)。 */
    secrets: SecretStore;
    repos: Repositories;
    /** 测试中直接读写数据库(模拟其他客户端的修改)。 */
    conn: Connection;
    /** 本测试期间写出的全部日志行。 */
    logs: string[];
    wechat: WechatChannels;
    /** channel.push 在测试中不真的发消息,只记在这里。 */
    pushed: Array<{ ownerId: string; channelId: string; text: string }>;
    plugins: PluginService;
    cleanup(): Promise<void>;
}

/**
 * 真实 SQLite 文件 + 完整应用。请求头 x-test-ip 模拟 TCP 对端地址(默认 127.0.0.1)。
 */
export interface TestServerOptions {
    /** 内置 Skill(ADR 0048);默认没有。 */
    builtinSkills?: BuiltinSkill[];
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
    /** browser.* 的网络选项(测试中指向本机服务器;开关仍由设置决定)。 */
    browser?: Pick<BrowserToolOptions, 'fetch'>;
    /** 客户端执行的调用(桌面浏览器截图,ADR 0046 第 14 节);给了就把 browser.screenshot 接到它。 */
    clientCalls?: ClientCalls;
    /** 打开 memory.write 的条件预授权(与生产一致);默认关闭,审批流程的测试每次都会弹审批。 */
    conditionalApprovals?: boolean;
    /** 邮件任务的执行方式(测试中用内存实现代替 worker 与真实服务器)。 */
    mailRunner?: MailJobRunner;
    /** 语音接口的限流与超时(ADR 0021)。 */
    voice?: AppDeps['voice'];
    /** 保存新时区后的回调(ADR 0023)。 */
    onTimeZoneChanged?: AppDeps['onTimeZoneChanged'];
    /** 渠道适配器(测试中用 @fatcat-ai/channels/testing 的假渠道)。 */
    channelAdapters?: Partial<Record<ChannelKind, AdapterFactory>>;
    /** 微信 iLink 指向假服务器(ADR 0024);设置后注册真实的微信适配器,地址校验放开为本机。 */
    wechatBaseUrl?: string;
    /** QQ 官方机器人指向假的 QQ 开放平台(ADR 0052);设置后注册真实的 QQ 适配器,网关地址校验放开为本机。 */
    qqPlatform?: { apiBaseUrl: string; tokenUrl: string };
    /** 渠道运行器的时钟(限流、配对码过期测试用)。 */
    now?: () => Date;
    /** 认证路由的时钟与临时凭证、第二因素限流(TOTP 测试用)。 */
    authNow?: () => Date;
    challenges?: AppDeps['challenges'];
    totpLimiter?: AppDeps['totpLimiter'];
    /** 设备配对 / 刷新的失败限速(ADR 0045)。 */
    pairLimiter?: AppDeps['pairLimiter'];
    taskComplete?: AppDeps['taskComplete'];
    /** 插件市场(ADR 0040 第 5.2 节):测试用的市场配置(测试公钥)与指向本机的网络检查。 */
    pluginMarket?: ConstructorParameters<typeof PluginService>[0]['market'];
    /** 固定网络隔离探测结果与备份大小上限(升级与平台限制的测试用)。 */
    pluginOverrides?: Pick<ConstructorParameters<typeof PluginService>[0], 'netIsolation' | 'backupLimitBytes'>;
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
    const secrets = new SecretStore({
        dataDir: dir,
        redactor,
        env: options.env ?? {},
        masterKey: dataDirMasterKey(dir, options.env ?? {}),
    });
    const providerDeps = {
        secrets,
        redactor,
        sleep: () => Promise.resolve(),
        ...(options.fetch ? { fetch: options.fetch } : {}),
    };
    const providerFor = (profile: Parameters<typeof createProvider>[0]) =>
        options.provider ??
        createProvider(profile, {
            ...providerDeps,
            // 按配置档所属账户检查密钥引用(管理员降为成员后,env: 等引用当作缺失;ADR 0053 第 5 节)
            secrets: ownerSecrets(repos, secrets, repos.modelProfiles.ownerOf(profile.id)),
        });
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
        dynamicProviders: () => plugins.itemProviders(),
        onSynced: (ownerId) => void kb.index(ownerId),
    });
    const bus = new EventBus();
    const pushed: TestServer['pushed'] = [];
    const attachmentFiles = createAttachmentFiles(dir);
    const skills = new SkillService({ repos, codeRoot: join(dir, 'plugins'), builtin: options.builtinSkills ?? [] });
    const runs = new RunManager({
        repos,
        bus,
        skills,
        persistIntervalMs: 0,
        providerFor,
        loadImage: createImageLoader(repos, attachmentFiles),
        tools: createToolRegistry(
            memory,
            repos,
            items,
            kb,
            {
                ...(options.webFetch ? { webFetch: options.webFetch } : {}),
                ...(options.browser || options.clientCalls
                    ? {
                          browser: {
                              ...options.browser,
                              ...(options.clientCalls ? { host: createClientBrowserHost(options.clientCalls) } : {}),
                          },
                      }
                    : {}),
                ...(options.clientCalls ? { systemOpen: { host: createClientOpenHost(options.clientCalls) } } : {}),
            },
            {
                runner: mailRunner,
                secret: (ref) => secrets.resolve(ref),
                complete: createMailComplete(repos, providerFor),
            },
            [
                createChannelPushTool(
                    async (ownerId, channelId, text) => void pushed.push({ ownerId, channelId, text }),
                ),
                createDelegateTool(),
            ],
        ),
        resolveAgent: (ownerId, ref) => resolveDelegateAgent(repos, ownerId, ref),
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
    const plugins = new PluginService({
        repos,
        coreVersion: SERVER_VERSION,
        registry: runs.tools,
        dataDir: dir,
        redact: (text) => redactor.redact(text),
        env: options.env ?? {},
        onItemsChanged: (ownerId) => items.invalidate(ownerId),
        runtime: { idleMs: 60_000, graceMs: 1000, termMs: 500, handshakeTimeoutMs: 15_000 },
        ...(options.pluginMarket ? { market: options.pluginMarket } : {}),
        ...options.pluginOverrides,
    });
    const mail = createMailService({
        repos,
        secrets,
        redact: (text) => redactor.redact(text),
        runner: mailRunner,
    });
    const logger = createLogger({ level: 'debug', destination, redactLine: (l) => redactor.redact(l) });
    const wechat = new WechatChannels({
        repos,
        secrets,
        logger,
        ...(options.wechatBaseUrl ? { baseUrl: options.wechatBaseUrl, allowUrl: () => true } : {}),
    });
    const qq = new QqChannels({
        repos,
        secrets,
        logger,
        ...(options.qqPlatform
            ? {
                  adapter: {
                      ...options.qqPlatform,
                      allowGatewayUrl: (url: string) => url.startsWith('ws://127.0.0.1:'),
                  },
              }
            : {}),
    });
    const adapters =
        options.channelAdapters ??
        (options.wechatBaseUrl || options.qqPlatform
            ? {
                  ...(options.wechatBaseUrl ? { wechat: wechat.factory } : {}),
                  ...(options.qqPlatform ? { qq: qq.factory } : {}),
              }
            : undefined);
    const channels = new ChannelHub({
        repos,
        runs,
        bus,
        secrets,
        ...channelHubServerDeps({ repos, runs, secrets, files: attachmentFiles }),
        logger,
        sourceUrl: overrides.sourceUrl ?? 'https://github.com/CodingLossy/FatCat-AI',
        ...(adapters ? { adapters } : {}),
        ...(options.now ? { now: options.now } : {}),
    });
    const app = createApp({
        backup: (tag) => backupDatabase(conn.sqlite, join(dir, 'backups'), tag, new Date()),
        ...(options.clientCalls ? { clientCalls: options.clientCalls } : {}),
        taskComplete: options.taskComplete ?? createMailComplete(repos, providerFor),
        channels,
        wechat,
        qq,
        mcp,
        plugins,
        skills,
        mail,
        kb,
        embeddings,
        config: {
            dataDir: dir,
            sourceUrl: 'https://github.com/CodingLossy/FatCat-AI',
            webDir: null,
            cookieSecure: 'auto',
            setupCode: TEST_SETUP_CODE,
            ...overrides,
        },
        repos,
        logger,
        secrets,
        providerDeps,
        bus,
        items,
        redact: (text) => redactor.redact(text),
        runs,
        memory,
        clientIp: (c) => c.req.header('x-test-ip') ?? '127.0.0.1',
        loginLimiter: new FailureLimiter(5, 60_000),
        ...(options.authNow ? { now: options.authNow } : {}),
        ...(options.challenges ? { challenges: options.challenges } : {}),
        ...(options.totpLimiter ? { totpLimiter: options.totpLimiter } : {}),
        ...(options.pairLimiter ? { pairLimiter: options.pairLimiter } : {}),
        attachmentFiles,
        ...(options.voice ? { voice: options.voice } : {}),
        ...(options.onTimeZoneChanged ? { onTimeZoneChanged: options.onTimeZoneChanged } : {}),
    });
    return {
        app,
        mail,
        bus,
        runs,
        channels,
        embeddings,
        kb,
        attachmentFiles,
        dir,
        secrets,
        repos,
        conn,
        logs,
        wechat,
        pushed,
        plugins,
        async cleanup() {
            await channels.stopAll();
            mcp.closeAll();
            await plugins.closeAll();
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
