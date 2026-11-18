// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件运行时(ADR 0040 第 3、4、8 节):按需启动、权限模型 + 预加载隔离、环境与密钥绑定、空闲停止、手动停止、
// 崩溃停用、心跳与 fatcat/log 路由、把声明的工具按风险下限注册进 ToolRegistry。
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
    FATCAT_METHODS,
    HeartbeatParams,
    LogParams,
    type PluginManifest,
    type PluginPermissions,
    type PluginToolPermission,
    type ToolRisk,
    type UntrustedContent,
} from '@fatcat-ai/shared';
import { type McpToolInfo, McpRpcError, StdioMcpClient } from '../mcp/client.js';
import { MAX_RESULT_CHARS, resultText, toolSegment } from '../mcp/manager.js';
import type { ToolRegistry } from '../registry.js';
import { type ToolDefinition, ToolDeniedError } from '../types.js';
import { findReparsePoint, pluginEnv, pluginNodeArgs } from './launch.js';
import { hashPluginDir } from './package.js';

const execFileAsync = promisify(execFile);

const RISK_ORDER: Record<string, number> = { read: 0, write: 1, external: 2 };
const MAX_DESCRIPTION_CHARS = 1024;
const CRASH_WINDOW_MS = 5 * 60_000;
const CRASH_LIMIT = 3;
const DENIED_WINDOW_MS = 60_000;
const DENIED_LIMIT = 20;
const LOG_PER_MINUTE = 60;
const LOG_MAX_CHARS = 1000;

/** 单插件的运行设置,存在 settings_json 的保留键下(第 8 节);默认都不设。 */
export interface PluginRuntimeSettings {
    maxOldSpaceMiB?: number;
    maxSemiSpaceMiB?: number;
    /** 内存阈值(MiB):连续两次超过就停止插件。 */
    memoryThresholdMiB?: number;
}
export const RUNTIME_SETTINGS_KEY = '__runtime';

export interface PluginRuntimeRecord {
    ownerId: string;
    pluginId: string;
    version: string;
    manifest: PluginManifest;
    granted: PluginPermissions;
    contentSha256: string;
    /** 名字 -> `env:变量名`。 */
    secretRefs: Record<string, string>;
    settings: Record<string, unknown>;
}

export type PluginRunState = 'running' | 'idle' | 'starting' | 'error' | 'disabled';

export interface PluginRuntimeStatus {
    state: PluginRunState;
    tools: string[];
    error: string | null;
    /** 最近一次 RSS 读数(字节);没有读数时 null。 */
    rssBytes: number | null;
    rssSource: 'measured' | 'self-reported' | null;
}

export type PluginEventInput = {
    pluginId: string;
    version: string | null;
    kind: 'stopped' | 'denied' | 'checksum-mismatch' | 'crashed' | 'memory-threshold' | 'disabled';
    detail: string;
};

export interface PluginRuntimeOptions {
    registry: ToolRegistry;
    /** `<数据目录>/plugins`:代码在 `<id>/<version>/`。 */
    codeRoot: string;
    /** `<数据目录>/plugin-data`:数据在 `<id>/`。 */
    dataRoot: string;
    env?: NodeJS.ProcessEnv;
    timeZone?: () => string | undefined;
    nodePath?: string;
    idleMs?: number;
    handshakeTimeoutMs?: number;
    requestTimeoutMs?: number;
    graceMs?: number;
    termMs?: number;
    now?: () => number;
    onEvent: (ownerId: string, event: PluginEventInput) => void;
    /** 运行时把插件置为 error / disabled 时通知存储层(例如崩溃停用)。 */
    onState: (ownerId: string, pluginId: string, state: 'error' | 'disabled', error: string) => void;
    log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
    readRss?: (pid: number) => Promise<number | null>;
}

interface Entry {
    record: PluginRuntimeRecord;
    client: StdioMcpClient | null;
    starting: Promise<StdioMcpClient> | null;
    tools: ToolDefinition[];
    registered: boolean;
    state: PluginRunState;
    error: string | null;
    idleTimer: ReturnType<typeof setTimeout> | null;
    expectedStop: boolean;
    crashes: number[];
    denied: number[];
    logTimes: number[];
    reportedRss: number | null;
    measuredRss: number | null;
    overThreshold: number;
    secretValues: string[];
}

/** 把文本里的密钥值替换掉(日志与事件写入前;ADR 0040 第 4.3 节)。 */
export function redactSecrets(text: string, values: readonly string[]): string {
    let out = text;
    for (const value of values) {
        if (value.length < 3) continue;
        // 原文、base64、base64url、URL 编码各替换一次
        const forms = new Set([
            value,
            Buffer.from(value).toString('base64'),
            Buffer.from(value).toString('base64url'),
            encodeURIComponent(value),
        ]);
        for (const form of forms) out = out.split(form).join('[redacted]');
    }
    return out;
}

/** 实际风险级别 = max(清单声明, 下限)(第 3.2 节)。 */
export function effectiveRisk(
    tool: Pick<PluginToolPermission, 'risk' | 'sendsData'>,
    hasNet: boolean,
): { risk: ToolRisk; preauthorizable: boolean } {
    let risk: ToolRisk = tool.risk ?? 'write';
    if (hasNet && RISK_ORDER[risk]! < RISK_ORDER.write!) risk = 'write';
    if (tool.sendsData) risk = 'external';
    return { risk, preauthorizable: risk !== 'external' };
}

export class PluginRuntime {
    private readonly entries = new Map<string, Entry>();
    private memoryTimer: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly options: PluginRuntimeOptions) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private groupOf(pluginId: string): string {
        return `plugin:${pluginId}`;
    }

    /** 启动(或重启)一个已启用的插件:握手、列工具、注册声明过的工具。失败时状态为 error。 */
    async apply(record: PluginRuntimeRecord): Promise<PluginRuntimeStatus> {
        await this.remove(record.pluginId);
        const entry: Entry = {
            record,
            client: null,
            starting: null,
            tools: [],
            registered: false,
            state: 'starting',
            error: null,
            idleTimer: null,
            expectedStop: false,
            crashes: [],
            denied: [],
            logTimes: [],
            reportedRss: null,
            measuredRss: null,
            overThreshold: 0,
            secretValues: [],
        };
        this.entries.set(record.pluginId, entry);
        try {
            const client = await this.ensureRunning(entry);
            const listed = await client.listTools();
            this.register(entry, listed);
            this.armIdle(entry);
            this.startMemoryMonitor();
        } catch (error) {
            await this.fail(entry, error);
        }
        return this.status(record.pluginId);
    }

    status(pluginId: string): PluginRuntimeStatus {
        const entry = this.entries.get(pluginId);
        if (!entry) return { state: 'disabled', tools: [], error: null, rssBytes: null, rssSource: null };
        const measured = entry.measuredRss !== null;
        return {
            state: entry.state,
            tools: entry.tools.map((t) => t.name),
            error: entry.error,
            rssBytes: measured ? entry.measuredRss : entry.reportedRss,
            rssSource: measured ? 'measured' : entry.reportedRss !== null ? 'self-reported' : null,
        };
    }

    /** 手动停止:进程退出,工具保持注册,下一次调用重新启动(第 4.1 节)。 */
    async stop(pluginId: string, detail = 'manual'): Promise<void> {
        const entry = this.entries.get(pluginId);
        if (!entry?.client) return;
        this.options.onEvent(entry.record.ownerId, {
            pluginId,
            version: entry.record.version,
            kind: 'stopped',
            detail,
        });
        await this.stopProcess(entry);
        if (entry.state === 'running' || entry.state === 'starting') entry.state = 'idle';
    }

    /** 注销工具并停止进程(停用、卸载、改配置前)。 */
    async remove(pluginId: string): Promise<void> {
        const entry = this.entries.get(pluginId);
        if (!entry) return;
        this.entries.delete(pluginId);
        this.options.registry.replaceGroup(this.groupOf(pluginId), []);
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.state = 'disabled';
        await this.stopProcess(entry);
    }

    async closeAll(): Promise<void> {
        if (this.memoryTimer) clearInterval(this.memoryTimer);
        this.memoryTimer = null;
        await Promise.all([...this.entries.keys()].map((id) => this.remove(id)));
    }

    // ───────────── 启动 ─────────────

    private ensureRunning(entry: Entry): Promise<StdioMcpClient> {
        if (entry.client) return Promise.resolve(entry.client);
        entry.starting ??= this.launch(entry).finally(() => {
            entry.starting = null;
        });
        return entry.starting;
    }

    private async launch(entry: Entry): Promise<StdioMcpClient> {
        const { record } = entry;
        const codeDir = join(this.options.codeRoot, record.pluginId, record.version);
        const dataDir = join(this.options.dataRoot, record.pluginId);
        if (/[,]/.test(codeDir) || /[,]/.test(dataDir)) {
            throw new PluginStartError('the data directory path must not contain a comma');
        }
        // 启动前核对代码目录的哈希(第 5.4 节):被改动就拒绝启动
        let actual: string;
        try {
            actual = hashPluginDir(codeDir);
        } catch (error) {
            throw new PluginStartError(`the plugin files cannot be checked: ${(error as Error).message}`);
        }
        if (actual !== record.contentSha256) {
            this.options.onEvent(record.ownerId, {
                pluginId: record.pluginId,
                version: record.version,
                kind: 'checksum-mismatch',
                detail: 'start',
            });
            throw new PluginStartError('the plugin files were modified');
        }
        mkdirSync(join(dataDir, 'home'), { recursive: true });
        mkdirSync(join(dataDir, 'tmp'), { recursive: true });
        const reparse = findReparsePoint(dataDir);
        if (reparse) throw new PluginStartError(`the plugin data directory contains a link (${reparse})`);

        const secrets: Record<string, string> = {};
        const source = this.options.env ?? process.env;
        for (const secret of record.manifest.permissions.secrets) {
            const ref = record.secretRefs[secret.name];
            const variable = ref?.startsWith('env:') ? ref.slice(4) : undefined;
            const value = variable ? source[variable] : undefined;
            if (value === undefined || value === '') {
                if (secret.required) {
                    throw new PluginStartError(
                        variable
                            ? `the environment variable ${variable} (for ${secret.name}) is not set`
                            : `the secret ${secret.name} is not bound to an environment variable`,
                    );
                }
                continue;
            }
            secrets[secret.name] = value;
        }
        entry.secretValues = Object.values(secrets);

        const runtime = (record.settings[RUNTIME_SETTINGS_KEY] ?? {}) as PluginRuntimeSettings;
        const args = pluginNodeArgs({
            codeDir,
            dataDir,
            main: record.manifest.entry.main,
            maxOldSpaceMiB: runtime.maxOldSpaceMiB,
            maxSemiSpaceMiB: runtime.maxSemiSpaceMiB,
        });
        const redact = (text: string) => redactSecrets(text, entry.secretValues);
        const client = new StdioMcpClient(
            {
                command: this.options.nodePath ?? process.execPath,
                args,
                cwd: dataDir,
                envPassthrough: [],
                rawEnv: pluginEnv({
                    pluginId: record.pluginId,
                    dataDir,
                    secrets,
                    timeZone: this.options.timeZone?.(),
                    source,
                }),
                priority: 5,
            },
            {
                timeoutMs: this.options.handshakeTimeoutMs ?? this.options.requestTimeoutMs ?? 30_000,
                redact,
                handler: {
                    request: (method, params) => this.handle(entry, method, params),
                    notify: (method, params) => void this.handle(entry, method, params).catch(() => undefined),
                },
            },
        );
        entry.client = client;
        entry.expectedStop = false;
        client.onClose = (reason) => void this.onClose(entry, client, reason);
        try {
            await client.connect();
        } catch (error) {
            const tail = client.stderrTail.slice(-500);
            client.close();
            entry.client = null;
            throw new PluginStartError(
                redact(`${error instanceof Error ? error.message : String(error)}${tail ? ` — ${tail}` : ''}`),
            );
        }
        entry.state = 'running';
        entry.error = null;
        return client;
    }

    private register(entry: Entry, listed: McpToolInfo[]): void {
        const { record } = entry;
        const declared = new Map(record.granted.tools.map((t) => [t.name, t]));
        const hasNet = record.granted.net.length > 0;
        const defs: ToolDefinition[] = [];
        for (const tool of listed) {
            const permission = typeof tool.name === 'string' ? declared.get(tool.name) : undefined;
            const segment = permission ? toolSegment(tool.name) : null;
            // 未声明的工具不注册;名字必须与声明完全一致(不做折叠,避免 a.b 与 a_b 变成同一个注册名)
            if (!permission || !segment || segment !== tool.name) continue;
            const { risk, preauthorizable } = effectiveRisk(permission, hasNet);
            const name = `plugin.${record.pluginId}.${segment}`;
            const def: ToolDefinition = {
                name,
                description:
                    `${(tool.description ?? '').slice(0, MAX_DESCRIPTION_CHARS)} (plugin "${record.pluginId}")`.trim(),
                parameters:
                    tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' },
                risk,
                ...(preauthorizable ? {} : { preauthorizable: false as const }),
                source: 'plugin',
                server: record.pluginId,
                untrustedOutput: true,
                summarize: (input) => {
                    const text = JSON.stringify(input ?? {});
                    return `${record.pluginId}: ${tool.name} ${text.length > 200 ? `${text.slice(0, 199)}…` : text}`;
                },
                execute: (input, context) => this.call(entry, tool.name, name, input, context.ownerId),
            };
            if (permission.constraint === 'domain') {
                def.constraints = { domain: (input) => hostOf(input) };
            }
            defs.push(def);
        }
        entry.tools = defs;
        this.options.registry.replaceGroup(this.groupOf(record.pluginId), defs);
        entry.registered = true;
    }

    private async call(entry: Entry, tool: string, name: string, input: unknown, ownerId: string): Promise<unknown> {
        if (ownerId !== entry.record.ownerId) throw new ToolDeniedError('This plugin belongs to another account.');
        if (this.entries.get(entry.record.pluginId) !== entry)
            throw new ToolDeniedError('This plugin is not available.');
        if (entry.state === 'error' || entry.state === 'disabled') {
            throw new ToolDeniedError(`This plugin is not running: ${entry.error ?? entry.state}`);
        }
        let client: StdioMcpClient;
        try {
            client = await this.ensureRunning(entry);
        } catch (error) {
            await this.fail(entry, error);
            throw new ToolDeniedError(`This plugin could not be started: ${entry.error ?? 'unknown error'}`);
        }
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        try {
            const result = await client.callTool(tool, input);
            const text = result.isError
                ? `[The plugin tool reported an error]\n${resultText(result)}`
                : resultText(result);
            const safe = redactSecrets(text, entry.secretValues);
            const output: UntrustedContent = {
                untrusted: true,
                source: { kind: 'plugin', ref: name },
                content: safe.slice(0, MAX_RESULT_CHARS),
                truncated: safe.length > MAX_RESULT_CHARS,
            };
            return output;
        } finally {
            this.armIdle(entry);
        }
    }

    // ───────────── fatcat/* 请求(第 3.3 节) ─────────────

    private async handle(entry: Entry, method: string, params: unknown): Promise<unknown> {
        switch (method) {
            case FATCAT_METHODS.log: {
                const parsed = LogParams.safeParse(params);
                if (!parsed.success) throw new McpRpcError('invalid params', -32602);
                const now = this.now();
                entry.logTimes = entry.logTimes.filter((t) => now - t < 60_000);
                if (entry.logTimes.length >= LOG_PER_MINUTE) return {}; // 超出丢弃
                entry.logTimes.push(now);
                const message = redactSecrets(parsed.data.message, entry.secretValues).slice(0, LOG_MAX_CHARS);
                const level = parsed.data.level === 'debug' ? 'info' : parsed.data.level;
                this.options.log?.[level === 'error' ? 'warn' : level]({ plugin: entry.record.pluginId }, message);
                return {};
            }
            case FATCAT_METHODS.heartbeat: {
                const parsed = HeartbeatParams.safeParse(params);
                if (parsed.success) entry.reportedRss = parsed.data.rss;
                return {};
            }
            case FATCAT_METHODS.netFetch:
                if (entry.record.granted.net.length === 0) return this.deny(entry, method, 'net is not granted');
                throw new McpRpcError('fatcat/net.fetch is not available in this version', -32601);
            case FATCAT_METHODS.itemsUpsert:
                if (!entry.record.granted.items) return this.deny(entry, method, 'items is not granted');
                throw new McpRpcError('fatcat/items.upsert is not available in this version', -32601);
            default:
                throw new McpRpcError('Method not found', -32601);
        }
    }

    private deny(entry: Entry, method: string, reason: string): never {
        const now = this.now();
        this.options.onEvent(entry.record.ownerId, {
            pluginId: entry.record.pluginId,
            version: entry.record.version,
            kind: 'denied',
            detail: `${method}: ${reason}`,
        });
        entry.denied = entry.denied.filter((t) => now - t < DENIED_WINDOW_MS);
        entry.denied.push(now);
        if (entry.denied.length > DENIED_LIMIT) {
            const message = 'the plugin was disabled after too many denied requests';
            this.options.onEvent(entry.record.ownerId, {
                pluginId: entry.record.pluginId,
                version: entry.record.version,
                kind: 'disabled',
                detail: message,
            });
            this.options.onState(entry.record.ownerId, entry.record.pluginId, 'disabled', message);
            void this.remove(entry.record.pluginId);
        }
        throw new McpRpcError('permission_denied', -32001, { code: 'permission_denied' });
    }

    // ───────────── 停止、崩溃、空闲、内存 ─────────────

    private armIdle(entry: Entry): void {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(
            () => void this.stop(entry.record.pluginId, 'idle'),
            this.options.idleMs ?? 600_000,
        );
        entry.idleTimer.unref();
    }

    private async stopProcess(entry: Entry): Promise<void> {
        const client = entry.client;
        entry.expectedStop = true;
        entry.client = null;
        entry.measuredRss = null;
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        await client?.shutdown(this.options.graceMs ?? 5000, this.options.termMs ?? 2000);
    }

    private async onClose(entry: Entry, client: StdioMcpClient, reason: string): Promise<void> {
        if (entry.client !== client) return; // 已经是计划内的停止或已被替换
        entry.client = null;
        if (entry.expectedStop || this.entries.get(entry.record.pluginId) !== entry) return;
        const now = this.now();
        entry.crashes = entry.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
        entry.crashes.push(now);
        const tail = redactSecrets(client.stderrTail, entry.secretValues).slice(-500);
        this.options.onEvent(entry.record.ownerId, {
            pluginId: entry.record.pluginId,
            version: entry.record.version,
            kind: 'crashed',
            detail: `${reason}${tail ? ` — ${tail}` : ''}`.slice(0, 1000),
        });
        this.options.registry.replaceGroup(this.groupOf(entry.record.pluginId), []);
        entry.registered = false;
        if (entry.crashes.length >= CRASH_LIMIT) {
            const message = `the plugin crashed ${CRASH_LIMIT} times within 5 minutes`;
            entry.state = 'error';
            entry.error = message;
            this.options.onState(entry.record.ownerId, entry.record.pluginId, 'error', message);
            return;
        }
        // 重新拉起并重新注册;失败按启动失败处理
        entry.state = 'starting';
        try {
            const next = await this.ensureRunning(entry);
            this.register(entry, await next.listTools());
            this.armIdle(entry);
        } catch (error) {
            await this.fail(entry, error);
        }
    }

    private async fail(entry: Entry, error: unknown): Promise<void> {
        const message = redactSecrets(error instanceof Error ? error.message : String(error), entry.secretValues);
        entry.state = 'error';
        entry.error = message;
        this.options.registry.replaceGroup(this.groupOf(entry.record.pluginId), []);
        entry.registered = false;
        this.options.onState(entry.record.ownerId, entry.record.pluginId, 'error', message);
        await this.stopProcess(entry);
        entry.state = 'error';
    }

    private startMemoryMonitor(): void {
        if (this.memoryTimer) return;
        this.memoryTimer = setInterval(() => void this.checkMemory(), 30_000);
        this.memoryTimer.unref();
    }

    /** 读各运行中插件的 RSS(Linux /proc、macOS ps;Windows 只用心跳自报),超过用户设的阈值两次就停止。 */
    async checkMemory(): Promise<void> {
        for (const entry of [...this.entries.values()]) {
            const pid = entry.client?.pid;
            if (!entry.client || pid === undefined) continue;
            const measured = await (this.options.readRss ?? readRss)(pid).catch(() => null);
            if (measured !== null) entry.measuredRss = measured;
            const limit = ((entry.record.settings[RUNTIME_SETTINGS_KEY] ?? {}) as PluginRuntimeSettings)
                .memoryThresholdMiB;
            if (!limit) continue;
            const rss = measured ?? entry.reportedRss;
            if (rss !== null && rss > limit * 1024 * 1024) entry.overThreshold += 1;
            else entry.overThreshold = 0;
            if (entry.overThreshold >= 2) {
                entry.overThreshold = 0;
                this.options.onEvent(entry.record.ownerId, {
                    pluginId: entry.record.pluginId,
                    version: entry.record.version,
                    kind: 'memory-threshold',
                    detail: `rss above ${limit} MiB`,
                });
                await this.stopProcess(entry);
                entry.state = 'idle';
            }
        }
    }
}

export class PluginStartError extends Error {
    override readonly name = 'PluginStartError';
}

function hostOf(input: unknown): string | null {
    const url = (input as { url?: unknown } | null)?.url;
    if (typeof url !== 'string') return null;
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
}

async function readRss(pid: number): Promise<number | null> {
    if (process.platform === 'linux') {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8');
        const match = /^VmRSS:\s+(\d+) kB/m.exec(status);
        return match ? Number(match[1]) * 1024 : null;
    }
    if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
        const kb = Number(stdout.trim());
        return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
    }
    return null; // Windows:只用插件自报的心跳
}
