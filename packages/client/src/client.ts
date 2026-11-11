// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type {
    AccessToken,
    Attachment,
    ApprovalDecision,
    ApprovalRequest,
    ApprovalStatus,
    AuditEntry,
    AuthStatus,
    CreatedAccessToken,
    CreateSessionRequest,
    CreateTokenRequest,
    EmbeddingRebuildResult,
    EmbeddingStatus,
    FsRoot,
    FsRootInput,
    FsRootPatch,
    Item,
    ItemContent,
    ItemCounts,
    ItemSort,
    ItemSubtree,
    LoginRequest,
    McpServerInput,
    McpServerPatch,
    McpServerStatus,
    McpServerView,
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
    Settings,
    SettingsPatch,
    ToolInfo,
    ToolRisk,
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
            login: (body: LoginRequest) => t.json<LoginResponse>('/auth/login', { method: 'POST', body }),
            logout: () => t.json<void>('/auth/logout', { method: 'POST' }),
            me: () => t.json<Me>('/auth/me'),
            /** 仅 Node:初始化主人账户并直接换成个人访问令牌,不保留 Cookie 会话。 */
            setupForToken: async (body: SetupRequest & { tokenName: string; expiresInDays?: number }) => {
                const { tokenName, expiresInDays, ...setup } = body;
                return exchange(await t.raw('/auth/setup', { method: 'POST', body: setup }), tokenName, expiresInDays);
            },
            /** 仅 Node:用密码登录并换成个人访问令牌,不保留 Cookie 会话。 */
            loginForToken: async (body: LoginRequest & { tokenName: string; expiresInDays?: number }) => {
                const { tokenName, expiresInDays, ...login } = body;
                return exchange(await t.raw('/auth/login', { method: 'POST', body: login }), tokenName, expiresInDays);
            },
        },

        tokens: {
            list: () => t.json<Page<AccessToken>>('/tokens'),
            create: (body: CreateTokenRequest) => t.json<CreatedAccessToken>('/tokens', { method: 'POST', body }),
            revoke: (id: string) => t.json<void>(`/tokens/${enc(id)}`, { method: 'DELETE' }),
        },

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
        sessions: {
            list: (page: PageParams = {}) => t.json<Page<Session>>('/sessions', { query: { ...page } }),
            create: (body: CreateSessionRequest = {}) => t.json<Session>('/sessions', { method: 'POST', body }),
            get: (id: string) => t.json<Session>(`/sessions/${enc(id)}`),
            update: (id: string, body: UpdateSessionRequest) =>
                t.json<Session>(`/sessions/${enc(id)}`, { method: 'PATCH', body }),
            delete: (id: string) => t.json<void>(`/sessions/${enc(id)}`, { method: 'DELETE' }),
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
            search: (params: { q: string; type?: string; under?: string; limit?: number }) =>
                t.json<Page<Item>>('/items/search', { query: { ...params } }),
            changes: (params: PageParams = {}) => t.json<Page<Item>>('/items/changes', { query: { ...params } }),
            sync: () => t.json<void>('/items/sync', { method: 'POST' }),
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
            const headers: Record<string, string> = t.token ? { authorization: `Bearer ${t.token}` } : {};
            const factory: WebSocketFactory =
                options.webSocket ??
                ((u, h) => {
                    const Ctor = globalThis.WebSocket as unknown as new (
                        url: string,
                        init?: { headers: Record<string, string> },
                    ) => WebSocketLike;
                    // 浏览器里没有 headers 参数,靠同源 Cookie 鉴权
                    return Object.keys(h).length > 0 ? new Ctor(u, { headers: h }) : new Ctor(u);
                });
            return connectEvents(url, headers, factory, connect);
        },
    };
}

export type FatCatClient = ReturnType<typeof createClient>;
