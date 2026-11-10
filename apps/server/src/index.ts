// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { EventBus, RunManager } from '@ai-personal/agent';
import { createItemService, createKnowledgeBase } from '@ai-personal/items';
import { createProvider, Redactor, SecretStore } from '@ai-personal/providers';
import { createRepositories, openStorage } from '@ai-personal/storage';
import { createMailComplete, createSummarizer, createToolRegistry, createTurnExtractor } from './agent-setup.js';
import { runInWorker } from '@ai-personal/mail';
import { createApp } from './app.js';
import { createMcpControl } from './mcp-setup.js';
import { createMailService } from './mail-setup.js';
import { createMemoryStack } from './memory-setup.js';
import { startMaintenance } from './maintenance-setup.js';
import { itemProviders } from './memory-provider.js';
import { createEmbeddingService } from './embeddings.js';
import { randomToken } from './auth/crypto.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { attachWebSocket } from './ws.js';

const config = loadConfig();
// 脱敏器登记本进程加载过的模型密钥;日志每一行写出前都经过它(ADR 0006)
const redactor = new Redactor();
const logger = createLogger({ level: config.logLevel, redactLine: (line) => redactor.redact(line) });

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const { conn, migrated } = await openStorage({ dataDir: config.dataDir });
if (migrated.applied.length > 0) {
    logger.info({ applied: migrated.applied, backup: migrated.backupPath }, 'database migrated');
}
const repos = createRepositories(conn);
const secrets = new SecretStore({ dataDir: config.dataDir, redactor, onWarning: (msg) => logger.warn(msg) });

// 尚未初始化时,生成一次性设置码供非本机完成初始化;本机直连无需设置码(ADR 0004 第 2 节)
let setupCode = config.setupCode;
if (repos.owners.count() === 0) {
    if (setupCode === null) {
        setupCode = randomToken(9);
        // 设置码只在初始化前有效,打印到本地日志是有意为之,便于部署者从容器日志中读取
        logger.warn({ code: setupCode }, 'owner account not created yet; use this one-time setup code');
    } else {
        logger.warn('owner account not created yet; use the setup code from AIP_SETUP_CODE');
    }
}

const providerDeps = { secrets, redactor };
const providerFor = (profile: Parameters<typeof createProvider>[0]) => createProvider(profile, providerDeps);
// 嵌入队列:有 embed 配置档或已有向量表时才加载 sqlite-vec(ADR 0014)
const embeddings = createEmbeddingService({
    repos,
    providerFor,
    redact: (text) => redactor.redact(text),
    onError: (err) => logger.warn({ err }, 'embedding failed'),
});
// 知识库:条目同步之后在后台分块并入队嵌入(ADR 0015)
// 记忆:写入后排队嵌入并防抖重建 digest;每轮注入 digest 与记忆块(ADR 0007 第 5.6 节)
const memoryStack = createMemoryStack(repos, embeddings, {
    onError: (err) => logger.warn({ err }, 'memory digest rebuild failed'),
});
const { memory } = memoryStack;
const kb = createKnowledgeBase({
    repos,
    vectors: embeddings,
    onError: (err, { itemId }) => logger.warn({ err, itemId }, 'knowledge base indexing failed'),
});
const items = createItemService({
    providers: itemProviders(),
    repos,
    onError: (err, { provider }) => logger.warn({ err, provider }, 'item provider sync failed'),
    onSynced: (ownerId) => void kb.index(ownerId),
});
const bus = new EventBus();
const runs = new RunManager({
    repos,
    bus,
    providerFor,
    tools: createToolRegistry(
        memoryStack,
        repos,
        items,
        kb,
        {},
        {
            runner: runInWorker,
            secret: (ref) => secrets.resolve(ref),
            complete: createMailComplete(repos, providerFor),
        },
    ),
    memoryContext: (input) => memoryStack.context(input),
    redact: (text) => redactor.redact(text),
    summarize: createSummarizer(repos, providerFor),
    // 设置中「memory.write 每次都要审批」关闭条件预授权(ADR 0010 第 4 节)
    disableConditional: (ownerId) => repos.settings.get(ownerId).memory.alwaysApprove,
    onTurnFinished: createTurnExtractor(repos, memory, providerFor, (err, { runId }) =>
        logger.warn({ err, runId }, 'memory extraction failed'),
    ),
    onError: (err, { runId }) => logger.error({ err, runId }, 'run failed unexpectedly'),
});
// 记忆维护任务:每天 03:30 运行 decay / tier / expire,有对话进行中时推迟(ADR 0007 第 5.7 节)
const maintenance = startMaintenance({
    repos,
    removeVectors: (itemId) => repos.embeddings.removeItem(itemId),
    isBusy: () => runs.activeRuns > 0,
    onChanged: (ownerId) => memoryStack.digest.schedule(ownerId),
    onError: (err) => logger.warn({ err }, 'memory maintenance failed'),
});
const interrupted = runs.recoverInterrupted();
if (interrupted > 0) logger.warn({ count: interrupted }, 'marked runs interrupted by the previous shutdown as failed');

// 有已启用的 MCP 服务器时才加载 MCP 客户端并连接(ADR 0013 第 4 节)
const mcp = createMcpControl(runs.tools, {
    onError: (err, { server }) => logger.warn({ err, mcpServer: server }, 'MCP server failed to connect'),
});
for (const server of repos.mcpServers.allEnabled()) {
    void mcp.apply(server).then((status) => logger.info({ mcpServer: server.name, state: status.state }, 'MCP server'));
}

embeddings.start(repos.owners.ids());

// 邮件:每分钟检查到期的账户;同步在 worker 中进行,没有账户时不加载任何邮件库(ADR 0016 第 2 节)
const mail = createMailService({
    repos,
    secrets,
    redact: (text) => redactor.redact(text),
    onError: (err, { accountId }) => logger.warn({ err, mailAccount: accountId }, 'mail sync failed'),
});
mail.start();

const app = createApp({
    embeddings,
    config: { ...config, setupCode },
    repos,
    logger,
    secrets,
    providerDeps,
    bus,
    runs,
    memory: memoryStack,
    items,
    mcp,
    mail,
    kb,
    redact: (text) => redactor.redact(text),
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info({ host: info.address, port: info.port, dataDir: config.dataDir }, 'listening');
}) as Server;
const websockets = attachWebSocket(server, { repos, bus, logger });

function shutdown(signal: string): void {
    logger.info({ signal }, 'shutdown');
    websockets.close();
    mcp.closeAll();
    embeddings.stop();
    memoryStack.stop();
    maintenance.stop();
    mail.stop();
    server.close(() => {
        conn.close();
        process.exit(0);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
