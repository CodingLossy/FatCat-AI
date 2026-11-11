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
import type { FailureLimiter } from './auth/rate-limit.js';
import type { ServerConfig } from './config.js';
import type { AppEnv } from './env.js';
import { ApiError, handleError, notFound, problemResponse } from './errors.js';
import type { Logger } from './log.js';
import { authRoutes } from './routes/auth.js';
import { json } from './routes/common.js';
import { memoryRoutes } from './routes/memory.js';
import { modelRoutes } from './routes/models.js';
import { runRoutes } from './routes/runs.js';
import { settingsRoutes } from './routes/settings.js';
import type { ItemService, KnowledgeBase } from '@fatcat-ai/items';
import { fsRoutes } from './routes/fs.js';
import { itemRoutes } from './routes/items.js';
import { mcpRoutes } from './routes/mcp.js';
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
import { tokenRoutes } from './routes/tokens.js';
import { TRANSCRIPTION_OVERHEAD_BYTES, type VoiceRouteDeps, voiceRoutes } from './routes/voice.js';
import { WindowLimiter } from './voice-limit.js';
import { SERVER_VERSION } from './version.js';

export interface AppDeps {
    /** 嵌入队列与向量索引(ADR 0014);不给时按需创建(不会自动开始处理队列)。 */
    embeddings?: EmbeddingService;
    /** MCP 服务器的连接管理(ADR 0013);不给时按需创建。 */
    mcp?: McpControl;
    /** 邮件同步(ADR 0016);不给时按需创建(不会自动开始定时同步)。 */
    mail?: MailService;
    /** 知识库(ADR 0015):邮件附件入库、删除账户后的清理。 */
    kb?: KnowledgeBase;
    /** 条目索引的同步与打开(ADR 0012)。 */
    items: ItemService;
    /** 审计中的脱敏(通常是 providers 的 Redactor)。 */
    redact?: (text: string) => string;
    config: Pick<ServerConfig, 'sourceUrl' | 'webDir' | 'cookieSecure' | 'setupCode'>;
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
    loginLimiter?: FailureLimiter;
    /** 图片附件的文件(ADR 0020);不给时用内存实现,只适合测试与导出 OpenAPI 文档。 */
    attachmentFiles?: AttachmentFiles;
    /** 语音接口的限流与超时(ADR 0021 第 5 节);不给时每分钟各 20 次、默认超时。 */
    voice?: Partial<Pick<VoiceRouteDeps, 'limits' | 'timeouts'>>;
    /** 保存了新的用户时区后调用(维护任务重新排期,ADR 0023 第 5 节);参数是新的生效时区。 */
    onTimeZoneChanged?: (ownerId: string, timeZone: string) => void;
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
    app.use('*', secureHeaders({ crossOriginEmbedderPolicy: false }));
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
                    capabilities: ['chat', 'memory'],
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
                ...(deps.loginLimiter ? { loginLimiter: deps.loginLimiter } : {}),
            }),
        )
        .route('/', tokenRoutes({ repos, now }))
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
        .route('/', settingsRoutes({ repos, onTimeZoneChanged: deps.onTimeZoneChanged }))
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
        .route('/', memoryRoutes({ repos, memory: deps.memory, detectCredential }))
        .route('/', toolRoutes({ repos, runs: deps.runs, redact: deps.redact ?? ((text) => text) }))
        .route('/', fsRoutes({ repos, items: deps.items, redact: deps.redact ?? ((text) => text) }))
        .route('/', itemRoutes({ repos, items: deps.items }))
        .route(
            '/',
            mcpRoutes({
                repos,
                mcp: deps.mcp ?? createMcpControl(deps.runs.tools),
                redact: deps.redact ?? ((text) => text),
            }),
        )
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
        app.use('/*', serveStatic({ root: config.webDir }));
        app.get('*', (c, next) => (c.req.path.startsWith('/api/') ? next() : spaFallback(c, next)));
    }

    return app;
}
