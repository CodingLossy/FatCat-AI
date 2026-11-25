// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type {
    AccessToken,
    Agent,
    AgentCopyInput,
    AgentInput,
    AgentPatch,
    RunTree,
    Attachment,
    SpeechRequest,
    TranscriptionResult,
    ApprovalDecision,
    ApprovalRequest,
    ApprovalStatus,
    AuditEntry,
    AuthStatus,
    CreatedAccessToken,
    CreateSessionRequest,
    CreateTokenRequest,
    CreatedPairingCode,
    Device,
    DeviceEvent,
    DeviceTokens,
    PairDeviceRequest,
    RefreshDeviceTokenRequest,
    RenameDeviceRequest,
    EmbeddingRebuildResult,
    EmbeddingStatus,
    FsRoot,
    FsRootInput,
    FsRootPatch,
    Item,
    ItemContent,
    ItemAskRequest,
    ItemAskResponse,
    ItemCounts,
    ItemRel,
    ItemRelatedPage,
    ItemSort,
    ItemSubtree,
    LoginChallenge,
    LoginRequest,
    McpServerInput,
    McpServerPatch,
    Channel,
    ChannelCreate,
    ChannelPairing,
    QqCredentials,
    WechatLoginStart,
    WechatLoginState,
    ChannelPatch,
    ChannelStatus,
    McpServerStatus,
    McpServerView,
    PluginDetail,
    PluginEventView,
    PluginMarketListing,
    PluginPatch,
    PluginPrepared,
    PluginView,
    LoginResponse,
    Me,
    Memory,
    MemoryConflict,
    MemoryDigest,
    MemoryFeedbackBody,
    MemoryFeedbackResult,
    MemoryPatch,
    MemoryRetrieveInput,
    MemoryRetrieveResult,
    MemorySaveInput,
    MemorySaveResult,
    MemorySearchInput,
    MemorySearchResult,
    MemorySource,
    MemoryWriteResult,
    QuarantinedMemory,
    ConflictResolveInput,
    Message,
    MetaResponse,
    ModelProfile,
    ModelProfileInput,
    ModelProfilePatch,
    ModelTestResult,
    PreauthRemember,
    Preauthorization,
    Run,
    SendMessageAccepted,
    SendMessageRequest,
    Session,
    SetupRequest,
    TotpConfirmRequest,
    TotpEnableRequest,
    TotpLoginRequest,
    TotpRecoveryCodes,
    TotpSetup,
    TotpSetupRequest,
    TotpStatus,
    Settings,
    SettingsPatch,
    SkillInfo,
    SecretsMigrateRequest,
    SecretsMigrateResponse,
    SecretsStatus,
    TimeZoneInfo,
    EgressTargetList,
    ToolInfo,
    ToolRisk,
    ClientCallResult,
    UpdateSessionRequest,
    MailAccount,
    MailAccountInput,
    MailAccountPatch,
    MailAskResult,
    MailAttachmentKbResult,
    MailConnectionTest,
    MailDraft,
    MailDraftPatch,
    MailFolder,
    MailMessage,
    MailPreset,
    MailSyncResult,
    Task,
    TaskCreate,
    TaskDraftResult,
    TaskPatch,
    TaskRun,
    TaskSchedulePreview,
    TaskWebhookToken,
    SyncKind,
    SyncResponse,
} from '@fatcat-ai/shared';
import { RunStream, type StreamOptions } from './run-stream.js';
import { Transport, type TransportOptions } from './transport.js';
import {
    connectEvents,
    type ConnectEventsOptions,
    type EventConnection,
    type WebSocketFactory,
    type WebSocketLike,
} from './ws.js';

export interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

export interface PageParams {
    cursor?: string | undefined;
    limit?: number | undefined;
}

export interface SyncParams {
    cursor?: string | undefined;
    limit?: number | undefined;
    kinds?: SyncKind[] | undefined;
}

export interface ClientOptions extends TransportOptions {
    /** 自定义 WebSocket 构造;默认用全局 WebSocket(Node ≥ 22 / 浏览器)。 */
    webSocket?: WebSocketFactory | undefined;
}

/** 不重复的幂等键(ADR 0004 第 6 节);不依赖 crypto.randomUUID,以便在非安全上下文中使用。 */
function newClientMessageId(): string {
    const rand = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `c${Date.now().toString(36)}${rand}`;
}

const enc = encodeURIComponent;

/** 从登录 / 初始化响应中取出会话 Cookie(仅非浏览器环境可读 Set-Cookie)。 */
function sessionCookie(res: Response): string {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const pairs = list.map((c) => c.split(';')[0]!.trim()).filter((p) => p.startsWith('aip_'));
    if (!pairs.some((p) => p.startsWith('aip_session='))) {
        throw new Error('The server did not return a session cookie (token exchange is not available in browsers)');
    }
    return pairs.join('; ');
}

export function createClient(options: ClientOptions) {
    const t = new Transport(options);
    const sse = { accept: 'text/event-stream' };

    /** 用刚拿到的会话 Cookie 创建令牌,再登出这个 Cookie 会话。 */
    const exchange = async (res: Response, tokenName: string, expiresInDays?: number) => {
        const cookie = sessionCookie(res);
        const login = (await res.json()) as LoginResponse;
        const headers = { cookie, 'x-csrf-token': login.csrfToken };
        const body: CreateTokenRequest = { name: tokenName, ...(expiresInDays ? { expiresInDays } : {}) };
        const created = await t.json<CreatedAccessToken>('/tokens', { method: 'POST', body, headers });
        await t.raw('/auth/logout', { method: 'POST', headers }).catch(() => undefined);
        return { token: created, owner: login.owner };
    };

    const runStream = (open: () => Promise<Response>, stream?: StreamOptions, known?: { runId: string }) =>
        new RunStream(t, open, stream, known);

    return {
        baseUrl: t.baseUrl,

        meta: () => t.json<MetaResponse>('/meta'),

        auth: {
            status: () => t.json<AuthStatus>('/auth/status'),
            setup: (body: SetupRequest) => t.json<LoginResponse>('/auth/setup', { method: 'POST', body }),
            /** 已启用 TOTP 的账户在密码通过后返回 LoginChallenge(HTTP 202,没有会话);用 loginTotp 完成。 */
            login: (body: LoginRequest) =>
                t.json<LoginResponse | LoginChallenge>('/auth/login', { method: 'POST', body }),
            /** 提交验证码或恢复码,完成需要第二因素的登录。 */
            loginTotp: (body: TotpLoginRequest) => t.json<LoginResponse>('/auth/login/totp', { method: 'POST', body }),
            logout: () => t.json<void>('/auth/logout', { method: 'POST' }),
            me: () => t.json<Me>('/auth/me'),
            /** 仅 Node:初始化主人账户并直接换成个人访问令牌,不保留 Cookie 会话。 */
            setupForToken: async (body: SetupRequest & { tokenName: string; expiresInDays?: number }) => {
                const { tokenName, expiresInDays, ...setup } = body;
                return exchange(await t.raw('/auth/setup', { method: 'POST', body: setup }), tokenName, expiresInDays);
            },
            /** 仅 Node:用密码登录并换成个人访问令牌,不保留 Cookie 会话。 */
            loginForToken: async (
                body: LoginRequest & {
                    tokenName: string;
                    expiresInDays?: number;
                    /** 账户启用了 TOTP 时被调用,返回验证码或恢复码;不给则登录失败。 */
                    secondFactor?: () => Promise<{ code: string } | { recoveryCode: string }>;
                },
            ) => {
                const { tokenName, expiresInDays, secondFactor, ...login } = body;
                let res = await t.raw('/auth/login', { method: 'POST', body: login });
                if (res.status === 202) {
                    const challenge = (await res.json()) as LoginChallenge;
                    if (!secondFactor) throw new Error('This account needs a verification code (TOTP) to sign in');
                    const factor = await secondFactor();
                    res = await t.raw('/auth/login/totp', {
                        method: 'POST',
                        body: { challengeToken: challenge.challengeToken, ...factor },
                    });
                }
                return exchange(res, tokenName, expiresInDays);
            },
        },

        /** TOTP 两步验证的设置(ADR 0027);只能用浏览器会话,个人访问令牌会被拒绝。 */
        totp: {
            status: () => t.json<TotpStatus>('/auth/totp'),
            setup: (body: TotpSetupRequest) => t.json<TotpSetup>('/auth/totp/setup', { method: 'POST', body }),
            enable: (body: TotpEnableRequest) =>
                t.json<TotpRecoveryCodes>('/auth/totp/enable', { method: 'POST', body }),
            disable: (body: TotpConfirmRequest) => t.json<void>('/auth/totp/disable', { method: 'POST', body }),
            recoveryCodes: (body: TotpConfirmRequest) =>
                t.json<TotpRecoveryCodes>('/auth/totp/recovery-codes', { method: 'POST', body }),
        },

        tokens: {
            list: () => t.json<Page<AccessToken>>('/tokens'),
            create: (body: CreateTokenRequest) => t.json<CreatedAccessToken>('/tokens', { method: 'POST', body }),
            revoke: (id: string) => t.json<void>(`/tokens/${enc(id)}`, { method: 'DELETE' }),
        },

        /**
         * 设备配对(ADR 0045):createPairingCode / list / rename / revoke / events 要浏览器会话;
         * pair 与 refresh 是公开端点,手机用配对码或 refresh 令牌换令牌;signOut 是设备令牌自己登出。
         */
        devices: {
            createPairingCode: () => t.json<CreatedPairingCode>('/devices/pairing-codes', { method: 'POST' }),
            pair: (body: PairDeviceRequest) => t.json<DeviceTokens>('/devices/pair', { method: 'POST', body }),
            refresh: (body: RefreshDeviceTokenRequest) =>
                t.json<DeviceTokens>('/devices/token', { method: 'POST', body }),
            list: () => t.json<Page<Device>>('/devices'),
            rename: (id: string, body: RenameDeviceRequest) =>
                t.json<Device>(`/devices/${enc(id)}`, { method: 'PATCH', body }),
            revoke: (id: string) => t.json<void>(`/devices/${enc(id)}`, { method: 'DELETE' }),
            signOut: () => t.json<void>('/devices/self', { method: 'DELETE' }),
            events: () => t.json<Page<DeviceEvent>>('/devices/events'),
        },

        /** 增量同步(ADR 0045 第 2 节):不带 cursor 拿完整快照,之后带上次返回的 cursor 只拿变化;hasMore 为 true 时继续拉。 */
        sync: (query: SyncParams = {}) =>
            t.json<SyncResponse>('/sync', {
                query: {
                    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
                    ...(query.limit !== undefined ? { limit: query.limit } : {}),
                    ...(query.kinds ? { kinds: query.kinds.join(',') } : {}),
                },
            }),

        models: {
            list: () => t.json<Page<ModelProfile>>('/models'),
            create: (body: ModelProfileInput) => t.json<ModelProfile>('/models', { method: 'POST', body }),
            get: (id: string) => t.json<ModelProfile>(`/models/${enc(id)}`),
            update: (id: string, body: ModelProfilePatch) =>
                t.json<ModelProfile>(`/models/${enc(id)}`, { method: 'PATCH', body }),
            delete: (id: string) => t.json<void>(`/models/${enc(id)}`, { method: 'DELETE' }),
            test: (id: string) => t.json<ModelTestResult>(`/models/${enc(id)}/test`, { method: 'POST' }),
        },

        settings: {
            get: () => t.json<Settings>('/settings'),
            update: (body: SettingsPatch) => t.json<Settings>('/settings', { method: 'PUT', body }),
            /** 可选时区与服务器时区(ADR 0023);老服务器返回 404。 */
            timeZones: () => t.json<TimeZoneInfo>('/settings/time-zones'),
            /** 外连目标清单(ADR 0028),现算、只读;老服务器返回 404。 */
            egressTargets: () => t.json<EgressTargetList>('/settings/egress-targets'),
        },

        /** 密钥加密存储(ADR 0026);老服务器返回 404。响应里没有任何密钥值。 */
        secrets: {
            status: () => t.json<SecretsStatus>('/settings/secrets'),
            migrate: (body: SecretsMigrateRequest) =>
                t.json<SecretsMigrateResponse>('/settings/secrets/migrate', { method: 'POST', body }),
        },

        /** 图片附件(ADR 0020):先上传,再在发送消息时带上 attachmentIds。 */
        attachments: {
            upload: (file: Blob, fileName = 'image') => {
                const form = new FormData();
                form.append('file', file, fileName);
                return t.json<Attachment>('/attachments', { method: 'POST', body: form });
            },
            /** 浏览器同源 Cookie 会话可直接用作 <img src>;令牌鉴权的客户端用 read()。 */
            url: (id: string) => t.url(`/attachments/${enc(id)}`),
            read: async (id: string) => (await t.raw(`/attachments/${enc(id)}`)).blob(),
        },
        /** 语音(ADR 0021):录音转文字、文字转语音;密钥只在服务器。 */
        voice: {
            transcribe: (
                audio: Blob,
                options: { language?: string; profileId?: string; signal?: AbortSignal } = {},
            ) => {
                const form = new FormData();
                form.append('file', audio, 'audio');
                if (options.language) form.append('language', options.language);
                if (options.profileId) form.append('profileId', options.profileId);
                return t.json<TranscriptionResult>('/voice/transcriptions', {
                    method: 'POST',
                    body: form,
                    signal: options.signal,
                });
            },
            /** 返回原始响应,body 是逐块到达的音频流(Content-Type 按 format)。 */
            speak: (body: SpeechRequest, options: { signal?: AbortSignal } = {}) =>
                t.raw('/voice/speech', { method: 'POST', body, signal: options.signal }),
        },
        sessions: {
            list: (page: PageParams = {}) => t.json<Page<Session>>('/sessions', { query: { ...page } }),
            create: (body: CreateSessionRequest = {}) => t.json<Session>('/sessions', { method: 'POST', body }),
            get: (id: string) => t.json<Session>(`/sessions/${enc(id)}`),
            update: (id: string, body: UpdateSessionRequest) =>
                t.json<Session>(`/sessions/${enc(id)}`, { method: 'PATCH', body }),
            delete: (id: string) => t.json<void>(`/sessions/${enc(id)}`, { method: 'DELETE' }),
            /** 清空当前主人的全部对话。记忆保留。 */
            clear: () => t.json<void>('/sessions', { method: 'DELETE' }),
            messages: (id: string, page: PageParams = {}) =>
                t.json<Page<Message>>(`/sessions/${enc(id)}/messages`, { query: { ...page } }),
            /**
             * 发送消息并流式接收事件。未给 clientMessageId 时自动生成,断线重发不会产生重复回复。
             */
            send: (id: string, body: SendMessageRequest, stream: StreamOptions = {}) => {
                const payload = { ...body, clientMessageId: body.clientMessageId ?? newClientMessageId() };
                return runStream(
                    () =>
                        t.raw(`/sessions/${enc(id)}/messages`, {
                            method: 'POST',
                            body: payload,
                            headers: sse,
                            signal: stream.signal,
                        }),
                    stream,
                );
            },
            /** 发送消息但不等待事件(?stream=false),返回 202 的结果。 */
            sendAsync: (id: string, body: SendMessageRequest) =>
                t.json<SendMessageAccepted>(`/sessions/${enc(id)}/messages`, {
                    method: 'POST',
                    body,
                    query: { stream: 'false' },
                }),
            regenerate: (id: string, messageId: string, stream: StreamOptions = {}) =>
                runStream(
                    () =>
                        t.raw(`/sessions/${enc(id)}/messages/${enc(messageId)}/regenerate`, {
                            method: 'POST',
                            headers: sse,
                            signal: stream.signal,
                        }),
                    stream,
                ),
        },

        runs: {
            get: (id: string) => t.json<Run>(`/runs/${enc(id)}`),
            /** 委派树:这个运行与它委派出去的所有子运行(ADR 0042)。 */
            tree: (id: string) => t.json<RunTree>(`/runs/${enc(id)}/tree`),
            /** 续看:先补发 afterSeq 之后的事件,运行未结束时继续推送。 */
            events: (id: string, afterSeq = 0, stream: StreamOptions = {}) =>
                new RunStream(
                    t,
                    () =>
                        t.raw(`/runs/${enc(id)}/events`, {
                            headers: { ...sse, 'last-event-id': String(afterSeq) },
                            signal: stream.signal,
                        }),
                    stream,
                    { runId: id, afterSeq },
                ),
            cancel: (id: string) => t.json<{ cancelled: true }>(`/runs/${enc(id)}/cancel`, { method: 'POST' }),
            retry: (id: string, stream: StreamOptions = {}) =>
                runStream(
                    () =>
                        t.raw(`/runs/${enc(id)}/retry`, {
                            method: 'POST',
                            headers: sse,
                            signal: stream.signal,
                        }),
                    stream,
                ),
        },

        tools: {
            /** 工具及其风险级别与默认审批方式(ADR 0010)。 */
            list: () => t.json<Page<ToolInfo>>('/tools'),
        },

        clientCalls: {
            /** 桌面客户端把服务器请它执行的调用(例如浏览器截图)的结果交回(ADR 0046 第 14 节)。 */
            result: (callId: string, result: ClientCallResult) =>
                t.json<void>(`/tool-calls/${enc(callId)}/result`, { method: 'POST', body: result }),
        },

        approvals: {
            /** 审批请求(status=pending 用于跨会话的审批弹窗)。 */
            list: (params: PageParams & { status?: ApprovalStatus | undefined } = {}) =>
                t.json<Page<ApprovalRequest>>('/approvals', { query: { ...params } }),
            /** 批准或拒绝;批准时可带 remember(本会话 / 永久,external 与 dangerous 工具不允许)。 */
            decide: (callId: string, decision: ApprovalDecision['decision'], remember?: PreauthRemember) =>
                t.json<{ callId: string; decision: ApprovalDecision['decision'] }>(`/approvals/${enc(callId)}`, {
                    method: 'POST',
                    body: { decision, ...(remember ? { remember } : {}) },
                }),
        },

        items: {
            /** 知识地图(ADR 0012):顶层类别;服务器在数据过期时先同步。 */
            roots: () => t.json<Page<Item>>('/items/roots'),
            get: (id: string) => t.json<Item>(`/items/${enc(id)}`),
            children: (id: string, params: PageParams & { type?: string; kind?: Item['kind']; sort?: ItemSort } = {}) =>
                t.json<Page<Item>>(`/items/${enc(id)}/children`, { query: { ...params } }),
            ancestors: (id: string) => t.json<Page<Item>>(`/items/${enc(id)}/ancestors`),
            counts: (id: string) => t.json<ItemCounts>(`/items/${enc(id)}/counts`),
            subtree: (id: string, params: { depth?: number; limitPerNode?: number } = {}) =>
                t.json<ItemSubtree>(`/items/${enc(id)}/subtree`, { query: { ...params } }),
            content: (id: string) => t.json<ItemContent>(`/items/${enc(id)}/content`),
            /** 非 primary 边(出边与入边),如人物提及的邮件(ADR 0029)。 */
            related: (id: string, params: PageParams & { rel?: ItemRel } = {}) =>
                t.json<ItemRelatedPage>(`/items/${enc(id)}/related`, { query: { ...params } }),
            search: (params: { q: string; type?: string; under?: string; limit?: number }) =>
                t.json<Page<Item>>('/items/search', { query: { ...params } }),
            changes: (params: PageParams = {}) => t.json<Page<Item>>('/items/changes', { query: { ...params } }),
            sync: () => t.json<void>('/items/sync', { method: 'POST' }),
            /** 以条目或子树为上下文创建会话,返回预填提示词(不自动发送)。 */
            ask: (id: string, body: ItemAskRequest = { scope: 'item' }) =>
                t.json<ItemAskResponse>(`/items/${enc(id)}/ask`, { method: 'POST', body }),
        },

        fsRoots: {
            /** 文件工具可以访问的授权目录(ADR 0011);只能由用户增删。 */
            list: () => t.json<Page<FsRoot>>('/fs/roots'),
            add: (body: FsRootInput) => t.json<FsRoot>('/fs/roots', { method: 'POST', body }),
            remove: (id: string) => t.json<void>(`/fs/roots/${enc(id)}`, { method: 'DELETE' }),
            /** 选择这个目录里的文件是否进入知识库(ADR 0015 第 6 节)。 */
            update: (id: string, body: FsRootPatch) =>
                t.json<FsRoot>(`/fs/roots/${enc(id)}`, { method: 'PATCH', body }),
        },

        mail: {
            /** 邮件(ADR 0016)。账户只收密码引用(env: / file:),只能由用户增删改。 */
            presets: () => t.json<{ items: MailPreset[] }>('/mail/presets'),
            accounts: {
                list: () => t.json<Page<MailAccount>>('/mail/accounts'),
                get: (id: string) => t.json<MailAccount>(`/mail/accounts/${enc(id)}`),
                add: (body: MailAccountInput) => t.json<MailAccount>('/mail/accounts', { method: 'POST', body }),
                update: (id: string, body: MailAccountPatch) =>
                    t.json<MailAccount>(`/mail/accounts/${enc(id)}`, { method: 'PATCH', body }),
                remove: (id: string) => t.json<void>(`/mail/accounts/${enc(id)}`, { method: 'DELETE' }),
                folders: (id: string) => t.json<{ items: MailFolder[] }>(`/mail/accounts/${enc(id)}/folders`),
                test: (id: string) => t.json<MailConnectionTest>(`/mail/accounts/${enc(id)}/test`, { method: 'POST' }),
                sync: (id: string) => t.json<MailSyncResult>(`/mail/accounts/${enc(id)}/sync`, { method: 'POST' }),
            },
            /** 邮件内容是不可信数据,只能按纯文本显示。 */
            messages: (
                query: {
                    accountId?: string;
                    folder?: 'inbox' | 'sent';
                    unreadOnly?: boolean;
                    before?: string;
                    limit?: number;
                } = {},
            ) =>
                t.json<{ items: MailMessage[] }>('/mail/messages', {
                    query: {
                        accountId: query.accountId,
                        folder: query.folder,
                        unreadOnly: query.unreadOnly === undefined ? undefined : String(query.unreadOnly),
                        before: query.before,
                        limit: query.limit,
                    },
                }),
            message: (id: string) => t.json<MailMessage>(`/mail/messages/${enc(id)}`),
            /** 以这封邮件为上下文新建会话(会话从一开始就视为读过不可信内容)。 */
            ask: (id: string) => t.json<MailAskResult>(`/mail/messages/${enc(id)}/ask`, { method: 'POST' }),
            addAttachmentToKnowledgeBase: (attachmentId: string) =>
                t.json<MailAttachmentKbResult>(`/mail/attachments/${enc(attachmentId)}/knowledge-base`, {
                    method: 'POST',
                }),
            drafts: {
                list: () => t.json<{ items: MailDraft[] }>('/mail/drafts'),
                get: (id: string) => t.json<MailDraft>(`/mail/drafts/${enc(id)}`),
                update: (id: string, body: MailDraftPatch) =>
                    t.json<MailDraft>(`/mail/drafts/${enc(id)}`, { method: 'PATCH', body }),
                remove: (id: string) => t.json<void>(`/mail/drafts/${enc(id)}`, { method: 'DELETE' }),
            },
        },

        embeddings: {
            /** 嵌入配置档、向量索引与队列的状态(ADR 0014)。 */
            status: () => t.json<EmbeddingStatus>('/embeddings/status'),
            /** 删除向量索引并按当前 embed 配置档全部重新嵌入。 */
            rebuild: () => t.json<EmbeddingRebuildResult>('/embeddings/rebuild', { method: 'POST' }),
        },

        mcpServers: {
            /** MCP 服务器(stdio,ADR 0013);只能由用户增删改。 */
            list: () => t.json<Page<McpServerView>>('/mcp/servers'),
            add: (body: McpServerInput) => t.json<McpServerView>('/mcp/servers', { method: 'POST', body }),
            update: (id: string, body: McpServerPatch) =>
                t.json<McpServerView>(`/mcp/servers/${enc(id)}`, { method: 'PATCH', body }),
            remove: (id: string) => t.json<void>(`/mcp/servers/${enc(id)}`, { method: 'DELETE' }),
            status: (id: string) => t.json<McpServerStatus>(`/mcp/servers/${enc(id)}/status`),
        },

        skills: {
            /** 已安装的 Skill(ADR 0048):内置与插件提供的,含是否启用;内置 Skill 的开关走 settings.update。 */
            list: () => t.json<Page<SkillInfo>>('/skills'),
        },

        agents: {
            /** 代理(ADR 0042):预置角色只读,可以复制后修改;发消息时用 `agentId` 选择。 */
            list: () => t.json<Page<Agent>>('/agents'),
            get: (id: string) => t.json<Agent>(`/agents/${enc(id)}`),
            create: (body: AgentInput) => t.json<Agent>('/agents', { method: 'POST', body }),
            update: (id: string, body: AgentPatch) => t.json<Agent>(`/agents/${enc(id)}`, { method: 'PATCH', body }),
            remove: (id: string) => t.json<void>(`/agents/${enc(id)}`, { method: 'DELETE' }),
            copy: (id: string, body: AgentCopyInput = {}) =>
                t.json<Agent>(`/agents/${enc(id)}/copy`, { method: 'POST', body }),
        },

        plugins: {
            /** 插件(ADR 0040);只能由登录的主人管理,没有对应的 Agent 工具。 */
            list: () => t.json<Page<PluginView>>('/plugins'),
            get: (id: string) => t.json<PluginDetail>(`/plugins/${enc(id)}`),
            /** 复制并检查本地目录(不运行插件代码),返回要确认的权限与保护程度表。 */
            prepareLocal: (path: string) =>
                t.json<PluginPrepared>('/plugins/prepare', {
                    method: 'POST',
                    body: { source: { kind: 'local', path } },
                }),
            /** 下载并检查市场里的一个版本(不运行插件代码);下载地址只来自已验证的索引。 */
            prepareMarket: (market: string, id: string, version: string) =>
                t.json<PluginPrepared>('/plugins/prepare', {
                    method: 'POST',
                    body: { source: { kind: 'market', market, id, version } },
                }),
            /** 缓存的市场索引(不发网络请求);设置里关闭市场时 409 market_disabled。 */
            market: () => t.json<PluginMarketListing>('/plugins/market'),
            /** 重新下载并验证索引;失败或被拒绝时保留缓存,原因在返回的市场状态里。 */
            refreshMarket: () => t.json<PluginMarketListing>('/plugins/market/refresh', { method: 'POST' }),
            /**
             * 安装已 prepare 的包;accept 必须为 true(全部同意)。已装同名插件且包的版本更新时这就是升级;
             * 数据超过备份上限时需要 `skipDataBackup: true` 明确同意不备份。
             */
            install: (stagingId: string, options: { skipDataBackup?: boolean } = {}) =>
                t.json<PluginView>('/plugins/install', {
                    method: 'POST',
                    body: { stagingId, accept: true, ...(options.skipDataBackup ? { skipDataBackup: true } : {}) },
                }),
            /** 回退到上一个版本(恢复它的数据备份);没有上一个版本时 409。 */
            rollback: (id: string) => t.json<PluginView>(`/plugins/${enc(id)}/rollback`, { method: 'POST' }),
            update: (id: string, body: PluginPatch) =>
                t.json<PluginView>(`/plugins/${enc(id)}`, { method: 'PATCH', body }),
            stop: (id: string) => t.json<void>(`/plugins/${enc(id)}/stop`, { method: 'POST' }),
            uninstall: (id: string, purgeData = false) =>
                t.json<void>(`/plugins/${enc(id)}`, { method: 'DELETE', query: { purgeData: String(purgeData) } }),
            events: (id: string, params: PageParams = {}) =>
                t.json<Page<PluginEventView>>(`/plugins/${enc(id)}/events`, { query: { ...params } }),
        },

        channels: {
            /** IM 渠道(ADR 0022);响应里没有密钥,外部账号只有末 4 位。 */
            list: () => t.json<Page<Channel>>('/channels'),
            add: (body: ChannelCreate) => t.json<Channel>('/channels', { method: 'POST', body }),
            update: (id: string, body: ChannelPatch) =>
                t.json<Channel>(`/channels/${enc(id)}`, { method: 'PATCH', body }),
            remove: (id: string) => t.json<void>(`/channels/${enc(id)}`, { method: 'DELETE' }),
            /** 6 位配对码,10 分钟内一次有效;明文只出现在这个响应里。 */
            pair: (id: string) => t.json<ChannelPairing>(`/channels/${enc(id)}/pairing`, { method: 'POST' }),
            unbind: (id: string) => t.json<void>(`/channels/${enc(id)}/binding`, { method: 'DELETE' }),
            status: (id: string) => t.json<ChannelStatus>(`/channels/${enc(id)}/status`),
            /** 微信扫码登录(ADR 0024):qrContent 由客户端渲染成二维码,然后轮询 wechatLoginState。 */
            wechatLogin: (id: string) =>
                t.json<WechatLoginStart>(`/channels/${enc(id)}/wechat/login`, { method: 'POST' }),
            wechatLoginState: (id: string) => t.json<WechatLoginState>(`/channels/${enc(id)}/wechat/login`),
            /** QQ 官方机器人凭据(ADR 0052):AppSecret 写进服务器的 secrets.yaml,任何响应都不返回它。 */
            qqCredentials: (id: string, body: QqCredentials) =>
                t.json<void>(`/channels/${enc(id)}/qq/credentials`, { method: 'PUT', body }),
        },

        tasks: {
            /** 定时任务(ADR 0033):内置系统任务与(之后的)用户任务;运行记录只含元数据。 */
            list: () => t.json<Page<Task>>('/tasks'),
            create: (body: TaskCreate) => t.json<Task>('/tasks', { method: 'POST', body }),
            /** 一句话 → 草稿;草稿在确认前永远不会运行(ADR 0036)。 */
            propose: (text: string) => t.json<TaskDraftResult>('/tasks/propose', { method: 'POST', body: { text } }),
            /** 确认草稿(需要登录会话;version 是草稿的 updatedAt)。 */
            confirm: (id: string, version: string) =>
                t.json<Task>(`/tasks/${enc(id)}/confirm`, { method: 'POST', body: { version } }),
            /** 从已启用插件的任务模板建草稿;确认前不会运行(ADR 0040)。 */
            fromPluginTemplate: (pluginId: string, index: number) =>
                t.json<TaskDraftResult>('/tasks/from-plugin-template', { method: 'POST', body: { pluginId, index } }),
            /** 从已启用 Skill 的任务模板建草稿;模板的工具集写进任务;确认前不会运行(ADR 0048)。 */
            fromSkillTemplate: (skillId: string, index: number) =>
                t.json<TaskDraftResult>('/tasks/from-skill-template', { method: 'POST', body: { skillId, index } }),
            get: (id: string) => t.json<Task>(`/tasks/${enc(id)}`),
            update: (id: string, body: TaskPatch) => t.json<Task>(`/tasks/${enc(id)}`, { method: 'PATCH', body }),
            remove: (id: string) => t.json<void>(`/tasks/${enc(id)}`, { method: 'DELETE' }),
            /** 立即运行一次;已有排队或运行中的记录时服务器返回 409。 */
            run: (id: string) => t.json<TaskRun>(`/tasks/${enc(id)}/run`, { method: 'POST' }),
            /** 生成(或替换)Webhook 令牌;明文只出现在这个响应里。 */
            webhookToken: (id: string) =>
                t.json<TaskWebhookToken>(`/tasks/${enc(id)}/webhook-token`, { method: 'POST' }),
            runs: (id: string, params: PageParams = {}) =>
                t.json<Page<TaskRun>>(`/tasks/${enc(id)}/runs`, { query: { ...params } }),
            cancelRun: (runId: string) => t.json<TaskRun>(`/task-runs/${enc(runId)}/cancel`, { method: 'POST' }),
            /** 校验 cron 表达式并返回用户时区下接下来几次的触发时刻。 */
            schedulePreview: (expression: string, count = 3) =>
                t.json<TaskSchedulePreview>('/tasks/schedule-preview', { query: { expression, count } }),
        },

        preauthorizations: {
            list: () => t.json<Page<Preauthorization>>('/preauthorizations'),
            revoke: (id: string) => t.json<void>(`/preauthorizations/${enc(id)}`, { method: 'DELETE' }),
        },

        audit: {
            list: (
                params: PageParams & {
                    toolName?: string | undefined;
                    risk?: ToolRisk | undefined;
                    since?: string | undefined;
                } = {},
            ) => t.json<Page<AuditEntry>>('/audit', { query: { ...params } }),
        },

        memory: {
            list: (params: { limit?: number } = {}) => t.json<Page<Memory>>('/memory', { query: { ...params } }),
            save: (body: MemorySaveInput) => t.json<MemorySaveResult>('/memory', { method: 'POST', body }),
            search: (body: MemorySearchInput) => t.json<MemorySearchResult>('/memory/search', { method: 'POST', body }),
            get: (id: string) => t.json<Memory>(`/memory/${enc(id)}`),
            update: (id: string, body: MemoryPatch) => t.json<Memory>(`/memory/${enc(id)}`, { method: 'PATCH', body }),
            /** reason 为 undo 时审计记为「撤销」,否则为「忘记」(ADR 0007 第 5.8 节)。 */
            delete: (id: string, reason: 'undo' | 'forget' = 'forget') =>
                t.json<void>(`/memory/${enc(id)}`, { method: 'DELETE', query: { reason } }),
            retrieve: (body: MemoryRetrieveInput) =>
                t.json<MemoryRetrieveResult>('/memory/retrieve', { method: 'POST', body }),
            digest: () => t.json<MemoryDigest>('/memory/digest'),
            feedback: (id: string, body: MemoryFeedbackBody) =>
                t.json<MemoryFeedbackResult>(`/memory/${enc(id)}/feedback`, { method: 'POST', body }),
            sources: (id: string) => t.json<Page<MemorySource>>(`/memory/${enc(id)}/sources`),
            history: (id: string) => t.json<Page<Memory>>(`/memory/${enc(id)}/history`),
            conflicts: () => t.json<Page<MemoryConflict>>('/memory/conflicts'),
            resolveConflict: (id: string, body: ConflictResolveInput) =>
                t.json<void>(`/memory/conflicts/${enc(id)}/resolve`, { method: 'POST', body }),
            quarantine: () => t.json<Page<QuarantinedMemory>>('/memory/quarantine'),
            promote: (id: string) =>
                t.json<MemoryWriteResult>(`/memory/quarantine/${enc(id)}/promote`, { method: 'POST' }),
        },

        /** WebSocket 事件订阅,断线自动带 lastSeq 重连补发(ADR 0004 第 5 节)。 */
        connectEvents: (connect: ConnectEventsOptions): EventConnection => {
            const url = t.url('/ws').replace(/^http/, 'ws');
            const base: WebSocketFactory =
                options.webSocket ??
                ((u, h) => {
                    const Ctor = globalThis.WebSocket as unknown as new (
                        url: string,
                        init?: string[] | { headers: Record<string, string> },
                    ) => WebSocketLike;
                    const bearer = /^Bearer\s+(aip_dev_\S+)$/i.exec(h.authorization ?? '')?.[1];
                    // 浏览器里 WebSocket 不能设请求头:设备令牌放在子协议里(服务器只回选 fatcat.v1)
                    if (bearer) return new Ctor(u, ['fatcat.v1', `fatcat.bearer.${bearer}`]);
                    // 其余情况靠同源 Cookie 鉴权(Node 的全局 WebSocket 支持 headers 参数)
                    return Object.keys(h).length > 0 ? new Ctor(u, { headers: h }) : new Ctor(u);
                });
            // 令牌会刷新,所以每次(重)连接时现取
            const factory: WebSocketFactory = (u) => base(u, t.token ? { authorization: `Bearer ${t.token}` } : {});
            return connectEvents(url, {}, factory, connect);
        },
    };
}

export type FatCatClient = ReturnType<typeof createClient>;
