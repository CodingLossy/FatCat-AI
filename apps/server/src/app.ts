// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import {
    type HealthResponse,
    MAX_ATTACHMENT_BYTES,
    MAX_TRANSCRIPTION_BYTES,
    MetaResponseSchema,
    PROTOCOL_VERSION,
    SERVER_LICENSE,
} from '@fatcat-ai/shared';
import type { EventBus, RunManager } from '@fatcat-ai/agent';
import { detectCredential } from '@fatcat-ai/memory';
import type { MemoryStack } from './memory-setup.js';
import { createProvider, type ProviderDeps, type SecretStore } from '@fatcat-ai/providers';
import { newId, type Repositories } from '@fatcat-ai/storage';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { authMiddleware } from './auth/middleware.js';
import type { LoginChallenges } from './auth/login-challenge.js';
import type { AttemptLimiter } from './auth/rate-limit.js';
import type { ServerConfig } from './config.js';
import type { AppEnv } from './env.js';
import { ApiError, handleError, notFound, problemResponse } from './errors.js';
import type { Logger } from './log.js';
import { authRoutes } from './routes/auth.js';
import { json } from './routes/common.js';
import { memoryRoutes } from './routes/memory.js';
import { modelRoutes } from './routes/models.js';
import { agentRoutes } from './routes/agents.js';
import { skillRoutes } from './routes/skills.js';
import { SkillService } from './skills.js';
import { runRoutes } from './routes/runs.js';
import { settingsRoutes } from './routes/settings.js';
import type { ItemService, KnowledgeBase } from '@fatcat-ai/items';
import { fsRoutes } from './routes/fs.js';
import { itemRoutes } from './routes/items.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpRoutes } from './routes/mcp.js';
import { pluginRoutes } from './routes/plugins.js';
import { PluginService } from '@fatcat-ai/plugins';
import { embeddingRoutes } from './routes/embeddings.js';
import { createEmbeddingService, type EmbeddingService } from './embeddings.js';
import { createMcpControl, type McpControl } from './mcp-setup.js';
import { createMailService, type MailService } from './mail-setup.js';
import { mailRoutes } from './routes/mail.js';
import { mailMessageRoutes } from './routes/mail-messages.js';
import { toolRoutes } from './routes/tools.js';
import { sessionRoutes } from './routes/sessions.js';
import { attachmentRoutes, UPLOAD_OVERHEAD_BYTES } from './routes/attachments.js';
import { type AttachmentFiles, createMemoryAttachmentFiles } from './attachment-files.js';
import { deviceRoutes } from './routes/devices.js';
import { accountRoutes } from './routes/accounts.js';
import { AccountLifecycle } from './account-lifecycle.js';
import { syncRoutes } from './routes/sync.js';
import { tokenRoutes } from './routes/tokens.js';
import { channelRoutes } from './routes/channels.js';
import { hashToken, taskRoutes } from './routes/tasks.js';
import { timingSafeEqual } from 'node:crypto';
import type { TaskComplete } from './scheduler/nl-parse.js';
import { startScheduler, type Scheduler } from './scheduler-setup.js';
import { startMaintenance } from './maintenance-setup.js';
import { ChannelHub, QqChannels, WechatChannels } from '@fatcat-ai/channels/hub';
import { channelHubServerDeps } from './channel-setup.js';
import { TRANSCRIPTION_OVERHEAD_BYTES, type VoiceRouteDeps, voiceRoutes } from './routes/voice.js';
import { ClientCalls } from './client-calls.js';
import { clientCallRoutes } from './routes/client-calls.js';
import { WindowLimiter } from './voice-limit.js';
import { SERVER_VERSION } from './version.js';

export interface AppDeps {
    /** 嵌入队列与向量索引(ADR 0014);不给时按需创建(不会自动开始处理队列)。 */
    embeddings?: EmbeddingService;
    /** MCP 服务器的连接管理(ADR 0013);不给时按需创建。 */
    mcp?: McpControl;
    /** 插件管理(ADR 0040);不给时按需创建(只适合测试与导出 OpenAPI 文档,数据目录取 config.dataDir)。 */
    plugins?: PluginService;
    /** 已安装的 Skill(ADR 0048);不给时按 dataDir 下的插件目录创建(没有内置 Skill)。 */
    skills?: SkillService;
    /** 邮件同步(ADR 0016);不给时按需创建(不会自动开始定时同步)。 */
    mail?: MailService;
    /** 知识库(ADR 0015):邮件附件入库、删除账户后的清理。 */
    kb?: KnowledgeBase;
    /** 条目索引的同步与打开(ADR 0012)。 */
    items: ItemService;
    /** 审计中的脱敏(通常是 providers 的 Redactor)。 */
    redact?: (text: string) => string;
    config: Pick<ServerConfig, 'sourceUrl' | 'webDir' | 'cookieSecure' | 'setupCode'> & {
        dataDir?: string | undefined;
    };
    repos: Repositories;
    logger: Logger;
    /** 解析 apiKeyRef(env: / file:)。 */
    secrets: SecretStore;
    /** 创建模型 provider 所需的依赖;测试中可注入 fetch。 */
    providerDeps: ProviderDeps;
    /** 事件总线与运行管理(ADR 0004 第 5 节)。 */
    bus: EventBus;
    runs: RunManager;
    /** 记忆的写入、检索与 digest(REST 与 memory.* 工具共用)。 */
    memory: MemoryStack;
    now?: () => Date;
    /** 请求来源地址;默认取 TCP 对端地址(不信任 X-Forwarded-For)。 */
    clientIp?: (c: Context<AppEnv>) => string;
    loginLimiter?: AttemptLimiter;
    /** 设备配对 / 刷新的失败限速(测试注入)。 */
    pairLimiter?: AttemptLimiter;
    /** 第二因素的失败限速(ADR 0027 第 5 节);不给时每分钟 5 次。 */
    totpLimiter?: AttemptLimiter;
    /** 登录临时凭证(内存);测试可注入带假时钟的实例。 */
    challenges?: LoginChallenges;
    /** 图片附件的文件(ADR 0020);不给时用内存实现,只适合测试与导出 OpenAPI 文档。 */
    attachmentFiles?: AttachmentFiles;
    /** 语音接口的限流与超时(ADR 0021 第 5 节);不给时每分钟各 20 次、默认超时。 */
    voice?: Partial<Pick<VoiceRouteDeps, 'limits' | 'timeouts'>>;
    /** 保存了新的用户时区后调用(维护任务重新排期,ADR 0023 第 5 节);参数是新的生效时区。 */
    onTimeZoneChanged?: (ownerId: string, timeZone: string) => void;
    /** 通用任务调度器(ADR 0033);不给时建一个不排期的(只适合测试与导出 OpenAPI 文档)。 */
    scheduler?: Scheduler;
    /** 自然语言创建任务用的补全(ADR 0036);不给则 /tasks/propose 报错。 */
    taskComplete?: TaskComplete;
    /** IM 渠道的运行器(ADR 0022);不给时按需创建(没有注册任何适配器,只适合测试与导出 OpenAPI 文档)。 */
    channels?: ChannelHub;
    /** 客户端执行的调用(ADR 0046 第 14 节,桌面浏览器截图);不给时建一个没有任何连接的。 */
    clientCalls?: ClientCalls;
    /** 微信 iLink 的扫码授权与适配器工厂;测试时可指向假的 iLink 服务器。 */
    wechat?: WechatChannels;
    /** QQ 官方机器人的凭据保存与适配器工厂(ADR 0052);测试时可指向假的 QQ 开放平台。 */
    qq?: QqChannels;
    /** 删除账户前备份数据库(ADR 0053 第 2 节),返回备份路径;不给时删除账户回 500。 */
    backup?: (tag: string) => Promise<string>;
}

/** 每个用户每分钟的转写与朗读次数(ADR 0021 第 5 节)。 */
export const VOICE_REQUESTS_PER_MINUTE = 20;

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

function tcpPeer(c: Context<AppEnv>): string {
    try {
        return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

const metaRoute = createRoute({
    method: 'get',
    path: '/meta',
    tags: ['meta'],
    summary: 'Server version, protocol version, license and source URL (AGPL section 13)',
    responses: { 200: json(MetaResponseSchema, 'Meta') },
});

export function createApp(deps: AppDeps): OpenAPIHono<AppEnv> {
    const { config, repos, logger } = deps;
    const now = deps.now ?? (() => new Date());
    const clientIp = deps.clientIp ?? tcpPeer;
    const app = new OpenAPIHono<AppEnv>();
    const files = deps.attachmentFiles ?? createMemoryAttachmentFiles();
    const plugins =
        deps.plugins ??
        new PluginService({
            repos,
            coreVersion: SERVER_VERSION,
            registry: deps.runs.tools,
            dataDir: deps.config.dataDir ?? join(tmpdir(), 'fatcat-ai-plugins-unconfigured'),
            redact: deps.redact ?? ((text) => text),
        });
    const skills = deps.skills ?? new SkillService({ repos, codeRoot: plugins.codeRoot });
    const runDeps = { repos, bus: deps.bus, runs: deps.runs, secrets: deps.secrets, files };
    const embeddings =
        deps.embeddings ??
        createEmbeddingService({
            repos,
            providerFor: (profile) => createProvider(profile, deps.providerDeps),
            ...(deps.redact ? { redact: deps.redact } : {}),
        });

    const mail =
        deps.mail ?? createMailService({ repos, secrets: deps.secrets, redact: deps.redact ?? ((text) => text), now });

    const wechat = deps.wechat ?? new WechatChannels({ repos, secrets: deps.secrets, logger });
    const qq = deps.qq ?? new QqChannels({ repos, secrets: deps.secrets, logger });
    const channels =
        deps.channels ??
        new ChannelHub({
            repos,
            adapters: { wechat: wechat.factory, qq: qq.factory },
            runs: deps.runs,
            bus: deps.bus,
            secrets: deps.secrets,
            ...channelHubServerDeps({ repos, runs: deps.runs, secrets: deps.secrets, files }),
            logger,
            sourceUrl: config.sourceUrl,
            now,
        });

    wechat.attach(channels);
    qq.attach(channels);

    const scheduler =
        deps.scheduler ??
        startScheduler({
            repos,
            maintenance: startMaintenance({
                repos,
                removeVectors: () => {},
                isBusy: () => false,
                onChanged: () => {},
                onError: () => {},
            }),
            timeZone: () => 'UTC',
            onError: () => {},
            agent: { runs: deps.runs, secrets: deps.secrets },
            schedule: false,
        });

    const mcp = deps.mcp ?? createMcpControl(deps.runs.tools);
    const lifecycle = new AccountLifecycle({
        repos,
        runs: deps.runs,
        secrets: deps.secrets,
        channels,
        qq,
        mcp,
        scheduler,
        logger,
    });

    app.onError(handleError);

    // 请求 id、版本头与访问日志(只记方法、路径、状态与耗时,不记查询串、请求头或请求体)
    app.use('*', async (c, next) => {
        const incoming = c.req.header('X-Request-Id');
        const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : newId();
        const log = logger.child({ requestId });
        c.set('requestId', requestId);
        c.set('logger', log);
        c.set('auth', null);
        const start = performance.now();
        await next();
        c.header('X-Request-Id', requestId);
        c.header('X-AIP-Server-Version', SERVER_VERSION);
        // 验证码相关的响应(含错误)不得被缓存(ADR 0027 第 9 节)
        if (c.req.path === '/api/v1/auth/login/totp' || c.req.path.startsWith('/api/v1/auth/totp')) {
            c.header('Cache-Control', 'no-store');
        }
        log.info(
            {
                method: c.req.method,
                path: c.req.path,
                status: c.res.status,
                durationMs: Math.round(performance.now() - start),
            },
            'request',
        );
    });
    // 界面的内容安全策略(ADR 0046 第 3.4、14 节):界面会渲染不可信文本,这是 React 转义之外的第二道防线。
    // 只允许同源资源;样式要 unsafe-inline(React 的 style 属性);图片多一个 data:(内置图标)和 blob:(发送前的图片预览);
    // 音频多一个 blob:(朗读);不允许插件、被嵌入和跳转到别处的表单。
    app.use(
        '*',
        secureHeaders({
            crossOriginEmbedderPolicy: false,
            contentSecurityPolicy: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'blob:'],
                mediaSrc: ["'self'", 'blob:'],
                connectSrc: ["'self'"],
                workerSrc: ["'self'"],
                manifestSrc: ["'self'"],
                objectSrc: ["'none'"],
                frameAncestors: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
            },
        }),
    );
    const defaultLimit = bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) =>
            problemResponse(c, new ApiError(413, 'validation_failed', 'Payload Too Large', 'Body exceeds 2 MB.')),
    });
    // 图片上传单独放宽到 5 MiB + 表单开销;按 Content-Length 与已读字节数判断,不先读完整个请求体
    const uploadLimit = bodyLimit({
        maxSize: MAX_ATTACHMENT_BYTES + UPLOAD_OVERHEAD_BYTES,
        onError: (c) =>
            problemResponse(
                c,
                new ApiError(413, 'payload_too_large', 'Payload Too Large', 'Images must be at most 5 MiB.'),
            ),
    });
    const transcriptionLimit = bodyLimit({
        maxSize: MAX_TRANSCRIPTION_BYTES + TRANSCRIPTION_OVERHEAD_BYTES,
        onError: (c) =>
            problemResponse(
                c,
                new ApiError(413, 'payload_too_large', 'Payload Too Large', 'Recordings must be at most 10 MiB.'),
            ),
    });
    app.use('/api/*', (c, next) => {
        if (c.req.method === 'POST' && c.req.path === '/api/v1/attachments') return uploadLimit(c, next);
        if (c.req.method === 'POST' && c.req.path === '/api/v1/voice/transcriptions') {
            return transcriptionLimit(c, next);
        }
        return defaultLimit(c, next);
    });
    app.use('/api/v1/*', authMiddleware({ repos, now }));
    // Webhook 触发器(ADR 0035 第 4 节):不走会话认证,走任务专属令牌;体积上限 64 KiB;
    // 令牌不对、任务不存在、任务不是 Webhook 触发的,一律同样的 401
    app.post(
        '/hooks/:taskId',
        bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
        async (c) => {
            const task = repos.tasks.getById(c.req.param('taskId'));
            const given = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
            const stored = task && task.trigger.kind === 'webhook' ? repos.tasks.webhookTokenHash(task.id) : null;
            const actual = Buffer.from(hashToken(given));
            const expected = Buffer.from(stored ?? hashToken('no-token'));
            const ok = actual.length === expected.length && timingSafeEqual(actual, expected) && stored !== null;
            if (!task || !ok) return c.json({ error: 'unauthorized' }, 401);
            repos.tasks.touchWebhookToken(task.id);
            const body = (await c.req.text()).slice(0, 4000);
            const result = scheduler.engine.fireEvent(
                task.id,
                body ? `Webhook body: ${body}` : 'Webhook called without a body.',
            );
            return c.json({ result }, result === 'throttled' ? 429 : 202);
        },
    );

    app.get('/healthz', (c) => c.json<HealthResponse>({ status: 'ok' }));

    const v1 = new OpenAPIHono<AppEnv>()
        .openapi(metaRoute, (c) =>
            c.json(
                {
                    name: 'FatCat-AI' as const,
                    serverVersion: SERVER_VERSION,
                    protocolVersion: PROTOCOL_VERSION,
                    license: SERVER_LICENSE,
                    sourceUrl: config.sourceUrl,
                    capabilities: ['chat', 'memory', 'channels'],
                },
                200,
            ),
        )
        .route(
            '/',
            authRoutes({
                repos,
                now,
                cookieSecure: config.cookieSecure,
                setupCode: config.setupCode,
                clientIp,
                masterKey: deps.secrets.masterKey,
                ...(deps.loginLimiter ? { loginLimiter: deps.loginLimiter } : {}),
                ...(deps.totpLimiter ? { totpLimiter: deps.totpLimiter } : {}),
                ...(deps.challenges ? { challenges: deps.challenges } : {}),
            }),
        )
        .route('/', tokenRoutes({ repos, now }))
        .route(
            '/',
            accountRoutes({
                repos,
                now,
                lifecycle,
                backup:
                    deps.backup ??
                    (() =>
                        Promise.reject(
                            new ApiError(
                                500,
                                'internal',
                                'Internal Server Error',
                                'Database backups are not configured.',
                            ),
                        )),
            }),
        )
        .route(
            '/',
            deviceRoutes({ repos, now, clientIp, ...(deps.pairLimiter ? { pairLimiter: deps.pairLimiter } : {}) }),
        )
        .route(
            '/',
            modelRoutes({
                repos,
                secrets: deps.secrets,
                providerDeps: deps.providerDeps,
                onChanged: () => embeddings.kick(),
            }),
        )
        .route('/', embeddingRoutes({ embeddings }))
        .route(
            '/',
            settingsRoutes({
                repos,
                secrets: deps.secrets,
                log: (message, fields) => logger.info(fields, message),
                onTimeZoneChanged: deps.onTimeZoneChanged,
                pluginDomains: (ownerId) => plugins.egressDomains(ownerId),
                pluginMarkets: (ownerId) => plugins.market.egressTargets(ownerId),
            }),
        )
        .route('/', sessionRoutes(runDeps))
        .route('/', attachmentRoutes({ repos, files }))
        .route(
            '/',
            voiceRoutes({
                repos,
                providerDeps: deps.providerDeps,
                limits: deps.voice?.limits ?? {
                    transcribe: new WindowLimiter(VOICE_REQUESTS_PER_MINUTE, 60_000),
                    speak: new WindowLimiter(VOICE_REQUESTS_PER_MINUTE, 60_000),
                },
                ...(deps.voice?.timeouts ? { timeouts: deps.voice.timeouts } : {}),
            }),
        )
        .route('/', runRoutes(runDeps))
        .route('/', agentRoutes({ repos, runs: deps.runs }))
        .route('/', skillRoutes({ skills }))
        .route('/', channelRoutes({ repos, hub: channels, wechat, qq }))
        .route(
            '/',
            taskRoutes({
                repos,
                scheduler,
                tools: deps.runs.tools,
                complete: deps.taskComplete,
                pluginTemplate: (ownerId, pluginId, index) => plugins.taskTemplate(ownerId, pluginId, index),
                skillTemplate: (ownerId, skillId, index) => skills.taskTemplate(ownerId, skillId, index),
            }),
        )
        .route('/', memoryRoutes({ repos, memory: deps.memory, detectCredential }))
        .route('/', toolRoutes({ repos, runs: deps.runs, redact: deps.redact ?? ((text) => text) }))
        .route('/', clientCallRoutes({ calls: deps.clientCalls ?? new ClientCalls() }))
        .route(
            '/',
            fsRoutes({
                repos,
                items: deps.items,
                redact: deps.redact ?? ((text) => text),
                onRootsChanged: () => scheduler.syncWatchers(),
            }),
        )
        .route('/', itemRoutes({ repos, items: deps.items }))
        .route('/', syncRoutes({ repos }))
        .route(
            '/',
            mcpRoutes({
                repos,
                mcp,
                redact: deps.redact ?? ((text) => text),
            }),
        )
        .route('/', pluginRoutes({ plugins }))
        .route(
            '/',
            mailRoutes({ repos, secrets: deps.secrets, mail, items: deps.items, ...(deps.kb ? { kb: deps.kb } : {}) }),
        )
        .route(
            '/',
            mailMessageRoutes({
                repos,
                attachments: {
                    items: deps.items,
                    kb: deps.kb ?? {
                        indexContent: () => {
                            throw new Error('the knowledge base is not available on this server');
                        },
                    },
                    runner: mail.runner,
                    secret: (ref) => deps.secrets.resolve(ref),
                },
            }),
        );
    app.route('/api/v1', v1);

    // OpenAPI 文档同样需要鉴权(业主决定;CI 另导出静态文件)
    app.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
        type: 'http',
        scheme: 'bearer',
        description: 'Personal access token (aip_pat_...)',
    });
    app.openAPIRegistry.registerComponent('securitySchemes', 'session', {
        type: 'apiKey',
        in: 'cookie',
        name: 'aip_session',
    });
    app.doc31('/api/v1/openapi.json', {
        openapi: '3.1.0',
        info: { title: 'FatCat-AI API', version: SERVER_VERSION, license: { name: SERVER_LICENSE } },
        security: [{ bearer: [] }, { session: [] }],
    });

    app.all('/api/*', () => {
        throw notFound('Endpoint');
    });

    if (config.webDir) {
        // 托管 Web UI;非 /api 的未知路径回退到 index.html(前端路由)。
        const spaFallback = serveStatic({ root: config.webDir, path: 'index.html' });
        // Service worker 与 manifest 必须每次向服务器校验,否则升级后旧 worker 会一直生效。
        app.use('/*', async (c, next) => {
            await next();
            if (c.req.path === '/sw.js' || c.req.path === '/manifest.webmanifest' || c.req.path === '/offline.html') {
                c.header('Cache-Control', 'no-cache');
            }
        });
        app.use('/*', serveStatic({ root: config.webDir }));
        app.get('*', (c, next) => (c.req.path.startsWith('/api/') ? next() : spaFallback(c, next)));
    }

    return app;
}
