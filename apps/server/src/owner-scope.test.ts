// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// ownerId 覆盖审计(ADR 0051 第 4 节、ADR 0053 第 3 节):另一个账户(成员 someone-else)名下的每种资源,
// 管理员用它们的 id 调遍 OpenAPI 里每一条带路径参数的路由,回答和「不存在的 id」完全一样(多数是 404),
// 数据库里那个账户的数据一行不变。新加的带参数路由必须在 ROUTE_IDS 里登记。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@fatcat-ai/storage';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

const openapi = JSON.parse(readFileSync(new URL('../openapi/v1.json', import.meta.url), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
};

/** 带参数的路由的方法列表:`GET /api/v1/sessions/{id}` 这样的字符串。 */
function parameterizedRoutes(): string[] {
    const out: string[] = [];
    for (const [path, ops] of Object.entries(openapi.paths)) {
        if (!path.includes('{')) continue;
        for (const method of Object.keys(ops)) {
            if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) out.push(`${method.toUpperCase()} ${path}`);
        }
    }
    return out.sort();
}

/**
 * 路由里的资源类型 → fixtures 里的 id。按路径前缀匹配,最长的在前。不是「主人的资源」的路由在 NOT_OWNED 里写明原因。
 */
const ROUTE_IDS: [prefix: string, fixture: keyof Fixtures][] = [
    ['/api/v1/mail/accounts/', 'mailAccount'],
    ['/api/v1/mail/drafts/', 'draft'],
    ['/api/v1/mail/messages/', 'mailMessage'],
    ['/api/v1/mail/attachments/', 'mailAttachment'],
    ['/api/v1/memory/conflicts/', 'memoryConflict'],
    ['/api/v1/memory/quarantine/', 'quarantine'],
    ['/api/v1/memory/', 'memory'],
    ['/api/v1/mcp/servers/', 'mcpServer'],
    ['/api/v1/fs/roots/', 'fsRoot'],
    ['/api/v1/task-runs/', 'taskRun'],
    ['/api/v1/tasks/', 'task'],
    ['/api/v1/sessions/', 'session'],
    ['/api/v1/runs/', 'run'],
    ['/api/v1/agents/', 'agent'],
    ['/api/v1/channels/', 'channel'],
    ['/api/v1/models/', 'model'],
    ['/api/v1/items/', 'item'],
    ['/api/v1/attachments/', 'attachment'],
    ['/api/v1/tokens/', 'token'],
    ['/api/v1/devices/', 'device'],
    ['/api/v1/preauthorizations/', 'preauth'],
    ['/api/v1/plugins/', 'plugin'],
    ['/api/v1/approvals/', 'approvalCall'],
    ['/api/v1/tool-calls/', 'clientCall'],
];

interface Fixtures {
    session: string;
    message: string;
    run: string;
    agent: string;
    task: string;
    taskRun: string;
    channel: string;
    model: string;
    mailAccount: string;
    draft: string;
    mailMessage: string;
    mailAttachment: string;
    memory: string;
    memoryConflict: string;
    quarantine: string;
    mcpServer: string;
    fsRoot: string;
    item: string;
    attachment: string;
    token: string;
    device: string;
    preauth: string;
    plugin: string;
    approvalCall: string;
    /**
     * 客户端执行的调用只在内存里(ClientCalls),不进数据库:这里只核对「不存在」的回答;
     * 别人的调用拿不到由 client-calls.test.ts「结果只对本人、仅一次、迟到的拒绝」覆盖。
     */
    clientCall: string;
}

/** 和各资源 id 格式一致的「不存在的 id」。 */
const NONEXISTENT: Partial<Record<keyof Fixtures, () => string>> = {
    plugin: () => 'nobody-plugin',
    clientCall: () => `cc_${'b'.repeat(20)}`,
};

/** 这些表里只有「别人」的行,扫一遍之后必须一行不差;审计、事件这类追加型的表不比。 */
const COMPARED_TABLES = [
    'sessions',
    'messages',
    'runs',
    'agents',
    'tasks',
    'task_runs',
    'task_webhook_tokens',
    'channels',
    'channel_bindings',
    'channel_pairings',
    'model_profiles',
    'mail_accounts',
    'mail_drafts',
    'memory_facts',
    'mcp_servers',
    'fs_roots',
    'items',
    'message_attachments',
    'access_tokens',
    'devices',
    'tool_preauth',
    'plugins',
    'approval_requests',
];

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

async function setup() {
    s = await createTestServer();
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const send = (method: string, path: string, body?: unknown) =>
        s.app.request(path, {
            method,
            headers: { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    return { send };
}

/**
 * 另一个账户名下的一整套资源,全部直接写进数据库。2.0 起可以有多个账户(ADR 0053):用一个真的成员账户,
 * 外键照常开着,所以夹具里的每个引用都必须指向真的行。
 */
function seedOther(): Fixtures {
    const other = s.repos.owners.create({ username: 'someone-else', passwordHash: 'x' });
    expect(other.role).toBe('member');
    return seedRows(other.id);
}

function seedRows(other: string): Fixtures {
    const { repos, conn } = s;
    const session = repos.sessions.create(other, { title: 'theirs' }).id;
    const message = repos.messages.append(other, session, {
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
        status: 'complete',
    }).id;
    const run = repos.runs.create(other, { sessionId: session, inputMessageId: message }).id;
    const agent = repos.agents.create(other, {
        name: 'theirs',
        systemPrompt: '',
        modelProfileId: null,
        toolSet: ['kb.search'],
        memoryScope: 'none',
        maxDepth: 1,
        maxSteps: 5,
        budgetTokens: null,
        budgetSeconds: null,
    }).id;
    const task = repos.tasks.createUser(other, {
        name: 'theirs',
        trigger: { kind: 'webhook' },
        action: { kind: 'agent_prompt', prompt: 'hi' },
        outputs: [{ kind: 'conversation' }],
        policy: { maxAttempts: 1, misfire: 'skip', quietHours: null, maxRuntimeMinutes: 10 },
    }).id;
    repos.tasks.setWebhookTokenHash(task, createHash('sha256').update('t').digest('hex'));
    const taskRun = repos.tasks.createRun({
        taskId: task,
        trigger: 'manual',
        scheduledFor: new Date().toISOString(),
        status: 'running',
    }).id;
    const channel = repos.channels.create(other, { kind: 'wechat', label: 'theirs' }).id;
    repos.channels.bind(channel, 'their-account');
    const model = repos.modelProfiles.create(other, {
        label: 'theirs',
        kind: 'openai-compatible',
        baseURL: 'http://127.0.0.1:11434/v1',
        apiKeyRef: null,
        model: 'm',
        purpose: ['chat'],
    }).id;
    const mailAccount = repos.mail.create(other, {
        label: 'theirs',
        address: 'them@example.com',
        username: 'them@example.com',
        passwordRef: 'env:THEIR_PW',
        imap: { host: 'imap.example.com', port: 993, security: 'tls' },
        smtp: { host: 'smtp.example.com', port: 465, security: 'tls' },
        initialSyncDays: 30,
        syncIntervalMinutes: 5,
        appendToSent: false,
        enabled: true,
    }).id;
    const draft = repos.mailCache.createDraft(other, {
        accountId: mailAccount,
        to: ['x@example.com'],
        cc: [],
        subject: 's',
        text: 't',
        replyToMessageId: null,
        attachments: [],
    }).id;
    const memoryId = repos.memories.save(other, {
        text: 'They live in Hangzhou',
        memType: 'semantic',
        subtype: null,
        entityKey: 'user.location.city',
        cardinality: 'single',
        value: null,
        domain: 'life',
        sensitivity: 0,
        confidence: 0.9,
        origin: 'user_explicit',
    }).id;
    const mcpServer = repos.mcpServers.create(other, {
        name: 'theirs',
        command: 'node',
        args: [],
        envPassthrough: [],
        enabled: false,
        toolRisks: {},
    }).id;
    const fsRoot = repos.fsRoots.create(other, { path: s.dir, label: 'theirs' }).id;
    const item = repos.items.upsert(other, {
        source: 'contacts',
        sourceRef: 'p1',
        kind: 'content',
        type: 'person',
        title: 'Them',
        parentId: null,
    }).id;
    const attachment = repos.attachments.create(other, {
        mediaType: 'image/png',
        bytes: 1,
        sha256: 'a'.repeat(64),
        fileName: 'x.png',
    }).id;
    const token = repos.accessTokens.create({
        ownerId: other,
        name: 'theirs',
        tokenHash: 'b'.repeat(64),
        expiresAt: null,
    }).id;
    const preauth = repos.preauths.create(other, {
        toolName: 'kb.search',
        scope: 'always',
        sessionId: null,
        constraint: null,
    }).id;
    const plugin = repos.plugins.create(other, {
        pluginId: 'theirs',
        version: '1.0.0',
        sourceKind: 'local',
        sourceRef: '/tmp/theirs',
        contentSha256: 'c'.repeat(64),
        manifest: {},
        granted: {},
        state: 'disabled',
    }).pluginId;
    const approvalCall = newId();
    repos.approvals.create(other, {
        callId: approvalCall,
        runId: run,
        sessionId: session,
        toolName: 'fs.write',
        risk: 'write',
        summary: 'write',
        input: {},
        preauthorizable: false,
        expiresAt: new Date(Date.now() + 3600_000),
    });
    // 设备、邮件正文与附件、记忆冲突与隔离区要走完整流程才能产生:直接插行,只要 id 能被路由查到
    const device = newId();
    insertLoose(conn.sqlite, 'devices', { id: device, owner_id: other });
    return {
        session,
        message,
        run,
        agent,
        task,
        taskRun,
        channel,
        model,
        mailAccount,
        draft,
        mailMessage: newId(),
        mailAttachment: newId(),
        memory: memoryId,
        memoryConflict: newId(),
        quarantine: newId(),
        mcpServer,
        fsRoot,
        item,
        attachment,
        token,
        device,
        preauth,
        plugin,
        approvalCall,
        clientCall: `cc_${'a'.repeat(20)}`,
    };
}

/** 只填给出的列,其余用列默认值或按类型填一个占位值(NOT NULL 没有默认值时)。 */
function insertLoose(
    sqlite: TestServer['conn']['sqlite'],
    table: string,
    values: Record<string, string | number | null>,
): void {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
    }[];
    const row: Record<string, string | number | null> = {};
    for (const c of columns) {
        if (c.name in values) row[c.name] = values[c.name] ?? null;
        else if (c.notnull && c.dflt_value === null) row[c.name] = /INT|REAL/i.test(c.type) ? 0 : 'x';
    }
    const names = Object.keys(row);
    sqlite
        .prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((n) => `@${n}`).join(', ')})`)
        .run(row);
}

type Schema = {
    type?: string | string[];
    properties?: Record<string, Schema>;
    required?: string[];
    enum?: unknown[];
    items?: Schema;
    minItems?: number;
    minLength?: number;
    minimum?: number;
    pattern?: string;
    anyOf?: Schema[];
    oneOf?: Schema[];
    allOf?: Schema[];
    $ref?: string;
    const?: unknown;
};

/** 按 OpenAPI 的请求体 schema 拼一个最小的合法请求体,让请求走过参数校验、走到归属检查。 */
function minimal(schema: Schema | undefined, depth = 0): unknown {
    if (!schema || depth > 6) return undefined;
    if (schema.$ref) {
        const name = schema.$ref.split('/').pop()!;
        return minimal(
            (openapi as unknown as { components: { schemas: Record<string, Schema> } }).components.schemas[name],
            depth + 1,
        );
    }
    if (schema.const !== undefined) return schema.const;
    if (schema.enum) return schema.enum[0];
    const alt = schema.oneOf ?? schema.anyOf;
    if (alt) return minimal(alt[0], depth + 1);
    if (schema.allOf) return Object.assign({}, ...schema.allOf.map((x) => minimal(x, depth + 1) as object));
    const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
    switch (type) {
        case 'object': {
            const out: Record<string, unknown> = {};
            for (const key of schema.required ?? []) out[key] = minimal(schema.properties?.[key], depth + 1);
            return out;
        }
        case 'array':
            return Array.from({ length: schema.minItems ?? 0 }, () => minimal(schema.items, depth + 1));
        case 'string':
            if (schema.pattern === '^[0-9A-HJKMNP-TV-Z]{26}$') return newId();
            return 'x'.repeat(Math.max(1, schema.minLength ?? 1));
        case 'integer':
        case 'number':
            return schema.minimum ?? 1;
        case 'boolean':
            return false;
        default:
            return undefined;
    }
}

/** schema 里有细化规则(至少改一项、日期格式等),拼不出来的几条手写。 */
const BODIES: Record<string, unknown> = {
    'PATCH /api/v1/channels/{id}': { label: 'mine now' },
    'PUT /api/v1/channels/{id}/qq/credentials': { appId: '102030', appSecret: 'not-saved' },
    'PATCH /api/v1/tasks/{id}': { name: 'mine now' },
    'POST /api/v1/tasks/{id}/confirm': { version: '2026-01-01T00:00:00.000Z' },
    'POST /api/v1/tool-calls/{callId}/result': { ok: false, code: 'unsupported' },
};

function requestBody(method: string, template: string): unknown {
    const fixed = BODIES[`${method} ${template}`];
    if (fixed !== undefined) return fixed;
    const op = openapi.paths[template]?.[method.toLowerCase()] as
        { requestBody?: { content?: Record<string, { schema?: Schema }> } } | undefined;
    const schema = op?.requestBody?.content?.['application/json']?.schema;
    return schema ? minimal(schema) : undefined;
}

function snapshot(): string {
    return COMPARED_TABLES.map(
        (t) => `${t}:${JSON.stringify(s.conn.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())}`,
    ).join('\n');
}

describe('ownerId 覆盖(ADR 0051)', () => {
    it('每条带参数的路由都登记了资源类型', () => {
        const missing = parameterizedRoutes().filter(
            (route) => !ROUTE_IDS.some(([prefix]) => route.split(' ')[1]!.startsWith(prefix)),
        );
        expect(missing).toEqual([]);
    });

    it('越权:别人的资源和不存在的一样拿不到,数据一行不变', async () => {
        const { send } = await setup();
        const ids = seedOther();
        const before = snapshot();
        const leaks: string[] = [];
        // 对照:同一条路由用一个不存在的 id。别人的 id 必须得到一模一样的回答(状态码与错误码),不能多透露「它存在」;
        // 对照得到 400 说明请求体没过校验、根本没走到归属检查,也算失败(补 BODIES)。
        const answer = async (method: string, template: string, id: string) => {
            const path = template.replace('{messageId}', ids.message).replace(/\{[A-Za-z]+\}/, id);
            const res = await send(method, path, requestBody(method, template) ?? (method === 'GET' ? undefined : {}));
            const body = res.headers.get('content-type')?.includes('json')
                ? ((await res.json()) as { code?: string })
                : {};
            return `${res.status} ${body.code ?? ''}`.trim();
        };
        for (const route of parameterizedRoutes()) {
            const [method, template] = route.split(' ') as [string, string];
            const fixture = ROUTE_IDS.find(([prefix]) => template.startsWith(prefix))![1];
            const theirs = await answer(method, template, ids[fixture]);
            const nobody = await answer(method, template, (NONEXISTENT[fixture] ?? newId)());
            if (theirs !== nobody || /^2/.test(theirs) || /^400/.test(nobody)) {
                leaks.push(`${route}: theirs ${theirs}, nonexistent ${nobody}`);
            }
        }
        expect(leaks).toEqual([]);
        expect(snapshot()).toBe(before);
    });
});
