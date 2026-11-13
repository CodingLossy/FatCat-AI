// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { EventBus, RunManager } from '@fatcat-ai/agent';
import { createItemService, createKnowledgeBase } from '@fatcat-ai/items';
import { createProvider, Redactor, SecretStore } from '@fatcat-ai/providers';
import { applyLegacyEnv, effectiveTimeZone, legacyEnvWarning } from '@fatcat-ai/shared';
import { createRepositories, openStorage } from '@fatcat-ai/storage';
import { createMailComplete, createSummarizer, createToolRegistry, createTurnExtractor } from './agent-setup.js';
import { runInWorker } from '@fatcat-ai/mail';
import { createApp } from './app.js';
import { createMcpControl } from './mcp-setup.js';
import { createMailService } from './mail-setup.js';
import { createMemoryStack } from './memory-setup.js';
import { scheduleDaily, startMaintenance } from './maintenance-setup.js';
import { createAttachmentFiles, createImageLoader, sweepAttachments } from './attachment-files.js';
import { itemProviders } from './memory-provider.js';
import { createEmbeddingService } from './embeddings.js';
import { randomToken } from './auth/crypto.js';
import { loadConfig, SERVER_ENV_NAMES } from './config.js';
import { dataDirMasterKey, LEGACY_DATA_DIR_NAME, LegacyDataDirBusyError, migrateLegacyDataDir } from './data-dir.js';
import { runAuthCommand } from './auth-cli.js';
import { runSecretsCommand } from './secrets-cli.js';
import { createLogger } from './log.js';
import { attachWebSocket } from './ws.js';
import { ChannelHub } from './channels/hub.js';
import { WechatChannels } from './channels/wechat.js';

// 离线子命令:`node dist/index.js secrets migrate|rekey|cleanup`(ADR 0026);不启动服务器
if (process.argv[2] === 'secrets') {
    applyLegacyEnv(process.env, SERVER_ENV_NAMES);
    process.exit(
        runSecretsCommand(process.argv.slice(3), {
            dataDir: loadConfig().dataDir,
            env: process.env,
            out: (line) => console.log(line),
            err: (line) => console.error(line),
        }),
    );
}

// 离线子命令:`node dist/index.js auth reset-totp`(ADR 0027 第 7 节);不启动服务器
if (process.argv[2] === 'auth') {
    applyLegacyEnv(process.env, SERVER_ENV_NAMES);
    process.exit(
        runAuthCommand(process.argv.slice(3), {
            dataDir: loadConfig().dataDir,
            out: (line) => console.log(line),
            err: (line) => console.error(line),
        }),
    );
}

// 改名前的 AIP_* 环境变量暂时兼容读取(ADR 0019)
const legacyEnv = applyLegacyEnv(process.env, SERVER_ENV_NAMES);
const config = loadConfig();
// 脱敏器登记本进程加载过的模型密钥;日志每一行写出前都经过它(ADR 0006)
const redactor = new Redactor();
const logger = createLogger({ level: config.logLevel, redactLine: (line) => redactor.redact(line) });
if (legacyEnv.length > 0) logger.warn({ variables: legacyEnv }, legacyEnvWarning(legacyEnv));

// 使用默认数据目录时,把改名前的 ~/.ai-personal 迁到 ~/.fatcat-ai(只做一次,不覆盖已有目录;ADR 0019)
if (!process.env.FATCAT_AI_DATA_DIR) {
    const legacyDir = join(homedir(), LEGACY_DATA_DIR_NAME);
    let migration;
    try {
        migration = migrateLegacyDataDir(legacyDir, config.dataDir);
    } catch (error) {
        if (!(error instanceof LegacyDataDirBusyError)) throw error;
        // 旧服务器仍占用旧目录:不带堆栈,给出可操作的提示后以非零退出码退出(旧目录原样保留)
        logger.error({ from: error.from, to: error.to, code: error.code }, error.message);
        process.exit(1);
    }
    if (migration.action === 'renamed' || migration.action === 'copied') {
        logger.info(
            { from: legacyDir, to: config.dataDir, ...migration },
            'migrated the data directory to the new name',
        );
        if (migration.action === 'copied' && !migration.legacyRemoved) {
            logger.warn(
                { from: legacyDir },
                'copied the data directory but could not remove the old one; delete it manually',
            );
        }
    } else if (migration.action === 'kept-existing') {
        logger.warn(
            { from: legacyDir, to: config.dataDir },
            'both the old and the new data directory exist; using the new one and leaving the old one untouched',
        );
    }
}

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const { conn, migrated } = await openStorage({ dataDir: config.dataDir });
if (migrated.applied.length > 0) {
    logger.info({ applied: migrated.applied, backup: migrated.backupPath }, 'database migrated');
}
const repos = createRepositories(conn);
// 主密钥来源:FATCAT_MASTER_KEY → FATCAT_MASTER_KEY_FILE → 数据目录的 master.key。前两个格式不对时启动报错,不回退(ADR 0026)
const masterKey = dataDirMasterKey(config.dataDir, process.env, (msg) => logger.warn(msg));
try {
    masterKey.current();
} catch (error) {
    logger.error({ code: (error as { code?: string }).code }, (error as Error).message);
    process.exit(1);
}
const secrets = new SecretStore({ dataDir: config.dataDir, redactor, masterKey, onWarning: (msg) => logger.warn(msg) });
// 明文与密文同时存在:不猜,报错并说明处理办法
try {
    if (secrets.checkLayout() === 'plaintext') {
        logger.warn(
            'secrets.yaml is stored as plaintext; encrypt it from Settings → Secrets or run: node dist/index.js secrets migrate',
        );
    }
} catch (error) {
    logger.error({ code: (error as { code?: string }).code }, (error as Error).message);
    process.exit(1);
}

// 尚未初始化时,生成一次性设置码供非本机完成初始化;本机直连无需设置码(ADR 0004 第 2 节)
let setupCode = config.setupCode;
if (repos.owners.count() === 0) {
    if (setupCode === null) {
        setupCode = randomToken(9);
        // 设置码只在初始化前有效,打印到本地日志是有意为之,便于部署者从容器日志中读取
        logger.warn({ code: setupCode }, 'owner account not created yet; use this one-time setup code');
    } else {
        logger.warn('owner account not created yet; use the setup code from FATCAT_AI_SETUP_CODE');
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
    // 只记路径、原因、耗时、运行 id 与状态码;不记查询文本、记忆内容或嵌入接口的错误原文(ADR 0017 第 4 节)
    onDegraded: ({ path, reason, elapsedMs, httpStatus }, { runId }) =>
        logger.info({ path, reason, elapsedMs, runId, httpStatus }, 'memory.retrieve.degraded'),
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
const attachmentFiles = createAttachmentFiles(config.dataDir);
const runs = new RunManager({
    repos,
    bus,
    providerFor,
    loadImage: createImageLoader(repos, attachmentFiles),
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
// 1.0 单用户:定时任务按主人的生效时区排期(ADR 0023);还没有主人时跟随服务器
const ownerTimeZone = () => {
    const ownerId = repos.owners.ids()[0];
    return effectiveTimeZone(ownerId ? repos.settings.get(ownerId).timeZone : null);
};
// 记忆维护任务:每天 03:30(用户时区)运行 decay / tier / expire,有对话进行中时推迟(ADR 0007 第 5.7 节)
const maintenance = startMaintenance({
    timeZone: ownerTimeZone(),
    repos,
    removeVectors: (itemId) => repos.embeddings.removeItem(itemId),
    isBusy: () => runs.activeRuns > 0,
    onChanged: (ownerId) => memoryStack.digest.schedule(ownerId),
    onError: (err) => logger.warn({ err }, 'memory maintenance failed'),
});
// 图片附件的清理:每天与记忆维护同一时间,删除 24 小时内未被引用的附件与孤立文件(ADR 0020 第 3 节)
const sweepJob = scheduleDaily(() => {
    sweepAttachments(repos, attachmentFiles, new Date())
        .then((removed) => {
            if (removed > 0) logger.info({ removed }, 'removed unused attachments');
        })
        .catch((err: unknown) => logger.warn({ err }, 'attachment cleanup failed'));
}, ownerTimeZone());
// IM 渠道(ADR 0022):1.0 只有微信 iLink(ADR 0024);每天清理 3 天前的去重记录
const wechat = new WechatChannels({ repos, secrets, logger });
const channels = new ChannelHub({
    repos,
    runs,
    bus,
    secrets,
    files: attachmentFiles,
    logger,
    sourceUrl: config.sourceUrl,
    adapters: { wechat: wechat.factory },
});
const inboxJob = scheduleDaily(() => {
    const removed = channels.pruneInbox();
    if (removed > 0) logger.info({ removed }, 'pruned channel inbox');
}, ownerTimeZone());
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
channels.startAll();

// 邮件:每分钟检查到期的账户;同步在 worker 中进行,没有账户时不加载任何邮件库(ADR 0016 第 2 节)
const mail = createMailService({
    repos,
    secrets,
    redact: (text) => redactor.redact(text),
    onError: (err, { accountId }) => logger.warn({ err, mailAccount: accountId }, 'mail sync failed'),
});
mail.start();

const app = createApp({
    channels,
    wechat,
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
    attachmentFiles,
    // 改时区后:定时任务按新时区重新排期,嵌入队列按新的「今天」重新判断每日上限(ADR 0023 第 5 节)
    onTimeZoneChanged: (_ownerId, timeZone) => {
        maintenance.reschedule(timeZone);
        sweepJob.reschedule(timeZone);
        inboxJob.reschedule(timeZone);
        embeddings.kick();
        logger.info({ timeZone }, 'rescheduled daily jobs for the new time zone');
    },
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
    sweepJob.stop();
    inboxJob.stop();
    void channels.stopAll();
    mail.stop();
    server.close(() => {
        conn.close();
        process.exit(0);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
