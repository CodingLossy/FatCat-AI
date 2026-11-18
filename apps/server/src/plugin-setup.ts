// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件管理(ADR 0040 第 5.1、6.1、9 节):本地目录安装、启用 / 停用、停止、卸载,把运行时(@fatcat-ai/tools/plugins,
// 按需 import())与存储、预授权、审批、定时任务接在一起。没有安装任何插件时,不加载运行时代码。
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
    type PluginDetail,
    type PluginManifest,
    type PluginMarketListing,
    type PluginPrepareInput,
    type PluginTaskTemplate,
    type PluginPatch,
    type PluginPermissions,
    type PluginPrepared,
    type PluginProtection,
    type PluginRunInfo,
    type PluginView,
    parsePluginManifest,
    satisfiesEngine,
    validatePluginSettings,
} from '@fatcat-ai/shared';
import type { PluginRecord, Repositories } from '@fatcat-ai/storage';
import { inputDigest, type ToolRegistry } from '@fatcat-ai/tools';
import type {
    PluginEventInput,
    PluginRuntime,
    PluginRuntimeOptions,
    PluginRuntimeRecord,
    PluginRuntimeSettings,
    NetIsolation,
} from '@fatcat-ai/tools/plugins';
import type { ItemProvider } from '@fatcat-ai/items';
import type { MarketConfig } from '@fatcat-ai/tools/market';
import {
    downloadPackage,
    extractTgz,
    MarketError,
    PluginPackageError,
    validateStagedPackage,
} from '@fatcat-ai/tools/market';
import { ApiError, notFound } from './errors.js';
import { MarketService, type MarketNet } from './plugin-market.js';
import { createPluginItemProvider, pluginSource, upsertPluginItems } from './plugin-items.js';
import { SERVER_VERSION } from './version.js';

const RUNTIME_KEY = '__runtime';
const UNINSTALL_KEY = '__uninstall';
const STAGING_TTL_MS = 24 * 3600_000;

/**
 * 判断插件 engines 范围用的核心版本。开发树的版本号还是 0.0.0,此时按第一个支持插件的版本 1.1.0 判断
 * (ADR 0040 的示例清单写 `>=1.1.0`);正式版本号写进 package.json 后直接用它。
 */
export function pluginCoreVersion(version: string = SERVER_VERSION): string {
    return version === '0.0.0' ? '1.1.0' : version;
}

export interface PluginServiceOptions {
    repos: Repositories;
    registry: ToolRegistry | undefined;
    dataDir: string;
    redact: (text: string) => string;
    timeZone?: () => string | undefined;
    env?: NodeJS.ProcessEnv;
    log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
    now?: () => Date;
    /** 插件的条目来源有变化(安装、启用、停用、卸载)后调用,让知识地图在下一次读取前重新同步。 */
    onItemsChanged?: (ownerId: string) => void;
    /** 市场配置(测试用):默认只有内置的官方市场;`net` 让测试把下载指向本机的假服务器。 */
    market?: { markets?: readonly MarketConfig[]; net?: MarketNet };
    /** 运行时的可调参数(测试用)。 */
    runtime?: {
        idleMs?: number;
        graceMs?: number;
        termMs?: number;
        handshakeTimeoutMs?: number;
        netFetchOverrides?: PluginRuntimeOptions['netFetchOverrides'];
    };
}

interface Staged {
    ownerId: string;
    dir: string;
    manifest: PluginManifest;
    contentSha256: string;
    sourceRef: string;
    /** 市场安装:验证索引用的公钥 id 与市场 id;本地为 null。 */
    market: { id: string; keyId: string } | null;
    createdAt: number;
}

/** 递归规范化后比较:对象键排序、数组按元素的规范化文本排序(权限清单里的顺序没有意义)。 */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

export function samePermissions(a: PluginPermissions, b: PluginPermissions): boolean {
    return canonical(a) === canonical(b);
}

export function protectionTable(
    platform: NodeJS.Platform = process.platform,
    unreviewed = true,
    netIsolation: 'unshare' | 'sandbox-exec' | 'none' = 'none',
): PluginProtection[] {
    const direct: PluginProtection =
        netIsolation === 'none'
            ? {
                  key: 'direct-network',
                  level: 'layered',
                  detail: 'This platform cannot deny network access to the plugin process without extra privileges; network modules and sockets are blocked by a preload script, which is layered protection, not a guarantee.',
              }
            : netIsolation === 'unshare'
              ? {
                    key: 'direct-network',
                    level: 'layered',
                    detail: 'TCP/UDP and abstract sockets are denied by the operating system (empty Linux network namespace); local Unix socket files are blocked only by the preload script, which is layered protection.',
                }
              : {
                    key: 'direct-network',
                    level: 'layered',
                    detail: 'A macOS sandbox profile denies network access; this has not been verified on a real Mac yet, and the preload script blocks network modules and sockets as layered protection.',
                };
    const hostFiles: PluginProtection =
        platform === 'linux'
            ? {
                  key: 'host-files',
                  level: 'enforced',
                  detail: 'Node permission model; the probe suite passes on Linux.',
              }
            : {
                  key: 'host-files',
                  level: 'unverified',
                  detail: `Node permission model; the probe suite has not been run on this platform (${platform}) yet. Do not install plugins you do not trust.`,
              };
    const memory: PluginProtection =
        platform === 'win32'
            ? {
                  key: 'memory-threshold',
                  level: 'self-reported',
                  detail: 'Reported by the plugin itself (heartbeat); no threshold by default.',
              }
            : {
                  key: 'memory-threshold',
                  level: 'enforced',
                  detail: 'Measured by the server; no threshold by default.',
              };
    return [
        { key: 'approval', level: 'enforced', detail: 'Tool calls go through the existing approval flow.' },
        { key: 'untrusted-output', level: 'enforced', detail: 'Tool output is treated as untrusted content.' },
        hostFiles,
        { key: 'environment', level: 'enforced', detail: 'The server environment is not inherited.' },
        {
            key: 'brokered-network',
            level: 'none',
            detail: 'Requests through the server (fatcat/net.fetch) arrive in a later release; the plugin has no network access through the server yet.',
        },
        direct,
        { key: 'items-quota', level: 'none', detail: 'Knowledge-map items from plugins arrive in a later release.' },
        memory,
        {
            key: 'review',
            level: unreviewed ? 'none' : 'layered',
            detail: unreviewed
                ? 'Local, unsigned and not reviewed by the marketplace.'
                : 'Listed in a signed marketplace index and reviewed by its maintainers. The signature and checksum only show that this is the package that was reviewed, not that it is safe.',
        },
    ];
}

export class PluginService {
    private runtime: PluginRuntime | null = null;
    private netIsolation: NetIsolation | null = null;
    private isolationProbe: Promise<NetIsolation> | null = null;
    private loading: Promise<PluginRuntime> | null = null;
    private readonly staged = new Map<string, Staged>();
    readonly codeRoot: string;
    readonly dataRoot: string;
    private readonly stagingRoot: string;
    readonly market: MarketService;

    constructor(private readonly options: PluginServiceOptions) {
        this.market = new MarketService({
            repos: options.repos,
            dataDir: options.dataDir,
            ...(options.market?.markets ? { markets: options.market.markets } : {}),
            ...(options.market?.net ? { net: options.market.net } : {}),
            ...(options.now ? { now: options.now } : {}),
            ...(options.log ? { log: options.log } : {}),
        });
        this.codeRoot = join(options.dataDir, 'plugins');
        this.dataRoot = join(options.dataDir, 'plugin-data');
        this.stagingRoot = join(this.codeRoot, '.staging');
    }

    private now(): Date {
        return this.options.now?.() ?? new Date();
    }

    /** 探测操作系统层的网络隔离;只探测一次,并发调用共用同一个结果,不阻塞事件循环。 */
    private detectIsolation(): Promise<NetIsolation> {
        this.isolationProbe ??= import('@fatcat-ai/tools/plugins').then(async ({ detectNetIsolation }) => {
            this.netIsolation = await detectNetIsolation();
            return this.netIsolation;
        });
        return this.isolationProbe;
    }

    private async load(): Promise<PluginRuntime> {
        const registry = this.options.registry;
        if (!registry) throw new Error('tools are not enabled on this server');
        this.loading ??= import('@fatcat-ai/tools/plugins').then(async ({ PluginRuntime: Runtime }) => {
            const isolation = await this.detectIsolation();
            this.options.log?.info({ netIsolation: isolation.kind }, 'plugin network isolation');
            const runtime = new Runtime({
                netIsolation: isolation,
                allowFakeIp: (ownerId) => this.options.repos.settings.get(ownerId).network?.allowFakeIp === true,
                upsertItems: (ownerId, pluginId, items) => {
                    const record = this.options.repos.plugins.get(ownerId, pluginId);
                    if (!record) throw new Error('unknown plugin');
                    return upsertPluginItems(
                        this.options.repos,
                        ownerId,
                        pluginId,
                        record.granted as PluginPermissions,
                        items,
                    );
                },
                registry,
                codeRoot: this.codeRoot,
                dataRoot: this.dataRoot,
                ...(this.options.env ? { env: this.options.env } : {}),
                ...(this.options.timeZone ? { timeZone: this.options.timeZone } : {}),
                ...(this.options.log ? { log: this.options.log } : {}),
                ...this.options.runtime,
                onEvent: (ownerId, event) => this.recordEvent(ownerId, event),
                onState: (ownerId, pluginId, state, error) => {
                    this.options.repos.plugins.update(ownerId, pluginId, { state, error });
                },
            });
            this.runtime = runtime;
            return runtime;
        });
        return this.loading;
    }

    private recordEvent(ownerId: string, event: PluginEventInput): void {
        this.options.repos.plugins.addEvent(ownerId, {
            pluginId: event.pluginId,
            version: event.version,
            kind: event.kind,
            detail: this.options.redact(event.detail),
        });
    }

    // ───────────── 启动与关闭 ─────────────

    /** 服务启动时:清理过期暂存目录、完成中断的卸载、在后台拉起已启用的插件。 */
    async start(): Promise<void> {
        this.cleanStaging();
        const { repos } = this.options;
        // 已经装了插件才探测(没有插件时不加载任何插件代码);结果缓存,详情页的保护程度表直接用
        if (this.allRecords().length > 0) void this.detectIsolation().catch(() => undefined);
        for (const record of this.allRecords()) {
            if (record.state === 'uninstalling') {
                const purge =
                    (record.settings[UNINSTALL_KEY] as { purgeData?: boolean } | undefined)?.purgeData === true;
                await this.finishUninstall(record, purge);
            }
        }
        for (const record of this.allRecords().filter((r) => r.state === 'enabled')) {
            void this.activate(record).catch((error: unknown) =>
                this.options.log?.warn({ err: error, plugin: record.pluginId }, 'plugin failed to start'),
            );
        }
        void repos;
    }

    /** 已启用且有 `items` 授权的插件的条目提供者(第 3.3 节);运行时按需加载。 */
    itemProviders(): ItemProvider[] {
        return this.allRecords()
            .filter((r) => r.state === 'enabled' && (r.granted as PluginPermissions).items !== undefined)
            .map((r) =>
                createPluginItemProvider({
                    repos: this.options.repos,
                    pluginId: r.pluginId,
                    categories: () =>
                        (
                            this.options.repos.plugins.get(r.ownerId, r.pluginId)?.granted as
                                PluginPermissions | undefined
                        )?.items,
                    runtime: () => this.load(),
                }),
            );
    }

    async closeAll(): Promise<void> {
        await this.runtime?.closeAll();
    }

    private allRecords(): PluginRecord[] {
        // 1.0 单用户:所有 owner 的插件都要拉起
        return this.options.repos.plugins.listAll();
    }

    private cleanStaging(): void {
        if (!existsSync(this.stagingRoot)) return;
        for (const name of readdirSync(this.stagingRoot)) {
            const dir = join(this.stagingRoot, name);
            try {
                if (this.now().getTime() - statSync(dir).mtimeMs > STAGING_TTL_MS)
                    rmSync(dir, { recursive: true, force: true });
            } catch {
                // 下次再清
            }
        }
    }

    private runtimeRecord(record: PluginRecord): PluginRuntimeRecord {
        return {
            ownerId: record.ownerId,
            pluginId: record.pluginId,
            version: record.version,
            manifest: record.manifest as PluginManifest,
            granted: record.granted as PluginPermissions,
            contentSha256: record.contentSha256,
            secretRefs: record.secretRefs,
            settings: record.settings,
        };
    }

    private async activate(record: PluginRecord): Promise<void> {
        const runtime = await this.load();
        const status = await runtime.apply(this.runtimeRecord(record));
        if (status.state === 'error') return; // onState 已写入存储
        this.options.log?.info({ plugin: record.pluginId, tools: status.tools.length }, 'plugin ready');
    }

    // ───────────── 视图 ─────────────

    private missingSecrets(record: PluginRecord): string[] {
        const manifest = record.manifest as PluginManifest;
        return manifest.permissions.secrets.filter((s) => s.required && !record.secretRefs[s.name]).map((s) => s.name);
    }

    private runInfo(record: PluginRecord): PluginRunInfo {
        const status = this.runtime?.status(record.pluginId);
        if (!status || record.state !== 'enabled') {
            return { state: 'disabled', tools: [], rssBytes: null, rssSource: null };
        }
        return { state: status.state, tools: status.tools, rssBytes: status.rssBytes, rssSource: status.rssSource };
    }

    toView(record: PluginRecord): PluginView {
        const manifest = record.manifest as PluginManifest;
        const { [RUNTIME_KEY]: runtime, ...rest } = record.settings;
        const { [UNINSTALL_KEY]: _hidden, ...settings } = rest;
        void _hidden;
        return {
            id: record.pluginId,
            version: record.version,
            previousVersion: record.previousVersion,
            name: manifest.name,
            description: manifest.description,
            author: manifest.author,
            license: manifest.license,
            homepage: manifest.homepage ?? null,
            state: record.state,
            error: record.error,
            sourceKind: record.sourceKind,
            sourceRef: record.sourceRef,
            unreviewed: record.sourceKind === 'local',
            signedKeyId: record.signedKeyId,
            yanked: this.yanked(record),
            permissions: record.granted as PluginPermissions,
            secretRefs: record.secretRefs,
            missingSecrets: this.missingSecrets(record),
            settings,
            settingsSchema: manifest.settings ?? null,
            taskTemplates: manifest.taskTemplates ?? [],
            runtime: (runtime ?? {}) as PluginView['runtime'],
            run: this.runInfo(record),
            installedAt: record.installedAt,
            updatedAt: record.updatedAt,
        };
    }

    private yanked(record: PluginRecord): PluginView['yanked'] {
        if (record.sourceKind !== 'market') return null;
        const reason = this.market.yankedReason(record.sourceRef);
        return reason === null ? null : { reason };
    }

    list(ownerId: string): PluginView[] {
        return this.options.repos.plugins
            .list(ownerId)
            .filter((r) => r.state !== 'uninstalled')
            .map((r) => this.toView(r));
    }

    private require(ownerId: string, pluginId: string): PluginRecord {
        const record = this.options.repos.plugins.get(ownerId, pluginId);
        if (!record || record.state === 'uninstalled') throw notFound('Plugin');
        return record;
    }

    detail(ownerId: string, pluginId: string): PluginDetail {
        const record = this.require(ownerId, pluginId);
        return {
            ...this.toView(record),
            affectedTasks: this.affectedTasks(ownerId, pluginId).map((t) => ({ id: t.id, name: t.name })),
            protections: protectionTable(
                process.platform,
                record.sourceKind === 'local',
                this.netIsolation?.kind ?? 'none',
            ),
        };
    }

    /** 已启用插件的第 index 个任务模板(从模板建草稿用);插件不存在、没启用或没有这个模板时 404。 */
    taskTemplate(ownerId: string, pluginId: string, index: number): { name: string; template: PluginTaskTemplate } {
        const record = this.require(ownerId, pluginId);
        const template = (record.manifest as PluginManifest).taskTemplates?.[index];
        if (record.state !== 'enabled' || !template) throw notFound('Task template');
        return { name: (record.manifest as PluginManifest).name.en ?? record.pluginId, template };
    }

    private affectedTasks(ownerId: string, pluginId: string) {
        const prefix = `plugin.${pluginId}.`;
        return this.options.repos.tasks.list(ownerId).filter((task) => {
            const policy = task.policy;
            return (
                (policy.toolSet ?? []).some((name) => name.startsWith(prefix) || name === prefix) ||
                (policy.allowedTools ?? []).some((t) => t.tool.startsWith(prefix)) ||
                policy.fromPlugin === pluginId
            );
        });
    }

    // ───────────── 安装 ─────────────

    /** 复制并检查本地目录;不运行插件的任何代码。 */
    async prepareLocal(ownerId: string, sourcePath: string): Promise<PluginPrepared> {
        const { prepareLocalPackage, PluginPackageError } = await import('@fatcat-ai/tools/plugins');
        const isolation = await this.detectIsolation();
        mkdirSync(this.stagingRoot, { recursive: true });
        let prepared;
        try {
            prepared = prepareLocalPackage(sourcePath, {
                stagingRoot: this.stagingRoot,
                coreVersion: pluginCoreVersion(),
            });
        } catch (error) {
            if (error instanceof PluginPackageError) {
                throw new ApiError(400, error.code, 'Bad Request', error.message);
            }
            throw error;
        }
        const stagingId = prepared.stagingDir.slice(-16);
        this.staged.set(stagingId, {
            ownerId,
            dir: prepared.stagingDir,
            manifest: prepared.manifest,
            contentSha256: prepared.contentSha256,
            sourceRef: sourcePath,
            market: null,
            createdAt: this.now().getTime(),
        });
        return {
            stagingId,
            manifest: prepared.manifest,
            protections: protectionTable(process.platform, true, isolation.kind),
            unreviewed: true,
            market: null,
            installed: this.installedOf(ownerId, prepared.manifest.id),
        };
    }

    private installedOf(ownerId: string, pluginId: string) {
        const existing = this.options.repos.plugins.get(ownerId, pluginId);
        return existing && existing.state !== 'uninstalled'
            ? { version: existing.version, state: existing.state }
            : null;
    }

    prepare(ownerId: string, source: PluginPrepareInput['source']): Promise<PluginPrepared> {
        return source.kind === 'local' ? this.prepareLocal(ownerId, source.path) : this.prepareMarket(ownerId, source);
    }

    // ───────────── 市场(ADR 0040 第 5.2、5.3 节) ─────────────

    marketListing(ownerId: string): PluginMarketListing {
        return this.market.listing(ownerId, {
            coreVersion: pluginCoreVersion(),
            installed: (pluginId) => this.installedOf(ownerId, pluginId),
        });
    }

    async refreshMarket(ownerId: string): Promise<PluginMarketListing> {
        await this.market.refresh(ownerId);
        return this.marketListing(ownerId);
    }

    /**
     * 从市场下载、解包并检查一个版本;下载地址、大小、sha256 只来自已验证的索引。任何一步失败都删除暂存目录,
     * 已安装的东西一概不动。包内 plugin.json 的 id、版本与权限必须与索引条目一致(授权以包内清单为准)。
     */
    private async prepareMarket(
        ownerId: string,
        source: Extract<PluginPrepareInput['source'], { kind: 'market' }>,
    ): Promise<PluginPrepared> {
        const { market, keyId, index, entry, version } = this.market.resolve(
            ownerId,
            source.market,
            source.id,
            source.version,
        );
        const core = pluginCoreVersion();
        if (!satisfiesEngine(core, version.engines.fatcat)) {
            throw new ApiError(
                400,
                'plugin_incompatible',
                'Bad Request',
                `requires FatCat-AI ${version.engines.fatcat}, this is ${core}`,
            );
        }
        const isolation = await this.detectIsolation();
        mkdirSync(this.stagingRoot, { recursive: true });
        const stagingDir = join(this.stagingRoot, randomBytes(8).toString('hex'));
        try {
            const bytes = await downloadPackage(version, index.downloadHosts, this.market.downloadNet(ownerId));
            await extractTgz(bytes, stagingDir);
            const { manifest, contentSha256 } = validateStagedPackage(stagingDir, core);
            if (
                manifest.id !== entry.id ||
                manifest.version !== version.version ||
                !samePermissions(manifest.permissions, version.permissions)
            ) {
                throw new ApiError(
                    422,
                    'plugin_manifest_mismatch',
                    'Unprocessable Content',
                    'The plugin.json inside the package does not match the signed index entry (id, version or permissions).',
                );
            }
            const stagingId = stagingDir.slice(-16);
            this.staged.set(stagingId, {
                ownerId,
                dir: stagingDir,
                manifest,
                contentSha256,
                sourceRef: `${market.id}:${entry.id}@${version.version}`,
                market: { id: market.id, keyId },
                createdAt: this.now().getTime(),
            });
            return {
                stagingId,
                manifest,
                protections: protectionTable(process.platform, false, isolation.kind),
                unreviewed: false,
                market: { id: market.id, keyId },
                installed: this.installedOf(ownerId, manifest.id),
            };
        } catch (error) {
            rmSync(stagingDir, { recursive: true, force: true });
            throw this.marketError(ownerId, entry.id, version.version, error);
        }
    }

    private marketError(ownerId: string, pluginId: string, version: string, error: unknown): unknown {
        if (error instanceof PluginPackageError) return new ApiError(400, error.code, 'Bad Request', error.message);
        if (!(error instanceof MarketError)) return error;
        switch (error.code) {
            case 'plugin_checksum_mismatch':
                this.options.repos.plugins.addEvent(ownerId, {
                    pluginId,
                    version,
                    kind: 'checksum-mismatch',
                    detail: 'sha256',
                });
                return new ApiError(422, 'plugin_checksum_mismatch', 'Unprocessable Content', error.message);
            case 'plugin_too_large':
                return new ApiError(413, 'plugin_too_large', 'Content Too Large', error.message);
            default:
                return new ApiError(502, 'plugin_download_failed', 'Bad Gateway', error.message);
        }
    }

    async install(ownerId: string, stagingId: string): Promise<PluginView> {
        const staged = this.staged.get(stagingId);
        if (!staged || staged.ownerId !== ownerId || !existsSync(staged.dir)) {
            throw new ApiError(
                404,
                'plugin_staging_not_found',
                'Not Found',
                'The prepared package is gone; prepare it again.',
            );
        }
        const { repos } = this.options;
        const { manifest } = staged;
        const existing = repos.plugins.get(ownerId, manifest.id);
        if (existing && existing.state !== 'uninstalled') {
            throw new ApiError(
                409,
                'conflict',
                'Conflict',
                'This plugin is already installed. Upgrades are not supported yet.',
            );
        }
        const target = join(this.codeRoot, manifest.id, manifest.version);
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
        mkdirSync(join(this.codeRoot, manifest.id), { recursive: true });
        renameSync(staged.dir, target);
        this.staged.delete(stagingId);
        mkdirSync(join(this.dataRoot, manifest.id), { recursive: true, mode: 0o700 });

        const required = manifest.permissions.secrets.some((s) => s.required);
        const state = required ? 'disabled' : 'enabled';
        const record = existing
            ? repos.plugins.update(ownerId, manifest.id, {
                  version: manifest.version,
                  previousVersion: null,
                  sourceKind: staged.market ? 'market' : 'local',
                  sourceRef: staged.sourceRef,
                  signedKeyId: staged.market?.keyId ?? null,
                  contentSha256: staged.contentSha256,
                  manifest,
                  granted: manifest.permissions,
                  state,
                  error: null,
              })!
            : repos.plugins.create(ownerId, {
                  pluginId: manifest.id,
                  version: manifest.version,
                  sourceKind: staged.market ? 'market' : 'local',
                  sourceRef: staged.sourceRef,
                  signedKeyId: staged.market?.keyId ?? null,
                  contentSha256: staged.contentSha256,
                  manifest,
                  granted: manifest.permissions,
                  state,
              });
        repos.plugins.addEvent(ownerId, {
            pluginId: manifest.id,
            kind: 'installed',
            version: manifest.version,
            detail: staged.market ? `market ${staged.market.id}` : 'local',
        });
        if (state === 'enabled') void this.activate(record).catch(() => undefined);
        this.options.onItemsChanged?.(ownerId);
        return this.toView(record);
    }

    // ───────────── 修改、停止、卸载 ─────────────

    async patch(ownerId: string, pluginId: string, patch: PluginPatch): Promise<PluginView> {
        const { repos } = this.options;
        let record = this.require(ownerId, pluginId);
        const manifest = record.manifest as PluginManifest;
        const declared = new Set(manifest.permissions.secrets.map((s) => s.name));
        const secretRefs = { ...record.secretRefs };
        for (const [name, ref] of Object.entries(patch.secretRefs ?? {})) {
            if (!declared.has(name)) {
                throw new ApiError(
                    400,
                    'validation_failed',
                    'Bad Request',
                    `The plugin does not declare the secret ${name}.`,
                );
            }
            if (ref === null) delete secretRefs[name];
            else secretRefs[name] = ref;
        }
        const settings: Record<string, unknown> = { ...record.settings };
        if (patch.settings) {
            const problems = validatePluginSettings(manifest.settings, patch.settings);
            if (problems.length > 0) {
                throw new ApiError(400, 'validation_failed', 'Bad Request', 'Invalid plugin settings.', {
                    issues: problems.map((message) => ({ path: ['settings'], message })),
                });
            }
            const runtime = settings[RUNTIME_KEY];
            const uninstall = settings[UNINSTALL_KEY];
            for (const key of Object.keys(settings)) delete settings[key];
            for (const [key, value] of Object.entries(patch.settings)) {
                if (!key.startsWith('__')) settings[key] = value;
            }
            if (runtime !== undefined) settings[RUNTIME_KEY] = runtime;
            if (uninstall !== undefined) settings[UNINSTALL_KEY] = uninstall;
        }
        if (patch.runtime) {
            const current = { ...((settings[RUNTIME_KEY] as PluginRuntimeSettings | undefined) ?? {}) } as Record<
                string,
                unknown
            >;
            for (const [key, value] of Object.entries(patch.runtime)) {
                if (value === null) delete current[key];
                else if (value !== undefined) current[key] = value;
            }
            settings[RUNTIME_KEY] = current;
        }
        record = repos.plugins.update(ownerId, pluginId, { secretRefs, settings })!;

        // 解除了必需的密钥绑定:插件没有它就不能运行,同时停用(原因记在事件里)
        const unboundRequired = patch.enabled === undefined && this.missingSecrets(record).length > 0;
        const active = record.state === 'enabled' || record.state === 'error';
        const enabled = unboundRequired && active ? false : patch.enabled;
        const wantEnabled = enabled ?? record.state === 'enabled';
        if (enabled === true && this.missingSecrets(record).length > 0) {
            throw new ApiError(
                409,
                'plugin_secrets_missing',
                'Conflict',
                `Bind the required secrets first: ${this.missingSecrets(record).join(', ')}.`,
            );
        }
        if (enabled === false && active) {
            await this.runtime?.remove(pluginId);
            record = repos.plugins.update(ownerId, pluginId, { state: 'disabled', error: null })!;
            repos.plugins.addEvent(ownerId, {
                pluginId,
                kind: 'disabled',
                version: record.version,
                detail: unboundRequired ? 'required secret unbound' : 'user',
            });
        } else if (wantEnabled) {
            const wasEnabled = record.state === 'enabled';
            record = repos.plugins.update(ownerId, pluginId, { state: 'enabled', error: null })!;
            if (!wasEnabled)
                repos.plugins.addEvent(ownerId, { pluginId, kind: 'enabled', version: record.version, detail: 'user' });
            // 绑定、设置或启用状态变了:重新启动才生效
            void this.activate(record).catch(() => undefined);
        }
        this.options.onItemsChanged?.(ownerId);
        return this.toView(record);
    }

    async stop(ownerId: string, pluginId: string): Promise<void> {
        this.require(ownerId, pluginId);
        await this.runtime?.stop(pluginId, 'manual');
    }

    /** 卸载(第 6.1 节):幂等,中途失败时状态为 uninstalling,下次启动继续。 */
    async uninstall(ownerId: string, pluginId: string, purgeData: boolean): Promise<void> {
        const { repos } = this.options;
        const record = this.require(ownerId, pluginId);
        repos.plugins.update(ownerId, pluginId, {
            state: 'uninstalling',
            settings: { ...record.settings, [UNINSTALL_KEY]: { purgeData } },
        });
        await this.finishUninstall({ ...record, state: 'uninstalling' }, purgeData);
    }

    private async finishUninstall(record: PluginRecord, purgeData: boolean): Promise<void> {
        const { repos, redact } = this.options;
        const { ownerId, pluginId } = record;
        await this.runtime?.remove(pluginId);
        // 知识地图里这个插件的条目与边:内容在插件里,留着打不开(第 6.1 节)
        repos.items.removeSource(ownerId, pluginSource(pluginId));
        // 注销工具:运行时没加载时(服务刚启动)工具本来就没有注册
        const prefix = `plugin.${pluginId}.`;
        for (const p of repos.preauths.list(ownerId)) {
            if (!p.toolName.startsWith(prefix)) continue;
            repos.preauths.delete(ownerId, p.id);
            repos.audit.append(ownerId, {
                action: 'preauth-revoked',
                toolName: p.toolName,
                risk: 'write',
                callId: null,
                runId: null,
                sessionId: p.sessionId,
                decision: null,
                outcome: 'ok',
                summary: `Revoked pre-authorization for ${p.toolName} because its plugin was removed`,
                inputDigest: inputDigest(p.constraint, redact),
                error: null,
            });
        }
        for (const request of repos.approvals.list(ownerId, { limit: 200, status: 'pending' }).items) {
            if (request.toolName.startsWith(prefix)) repos.approvals.decide(ownerId, request.callId, 'cancelled');
        }
        for (const task of this.affectedTasks(ownerId, pluginId)) {
            repos.tasks.update(ownerId, task.id, { enabled: false, disabledReason: 'plugin_removed' });
        }
        rmSync(join(this.codeRoot, pluginId), { recursive: true, force: true });
        if (purgeData) rmSync(join(this.dataRoot, pluginId), { recursive: true, force: true });
        if (purgeData) repos.plugins.delete(ownerId, pluginId);
        else {
            const settings = { ...record.settings };
            delete settings[UNINSTALL_KEY];
            repos.plugins.update(ownerId, pluginId, { state: 'uninstalled', error: null, settings });
        }
        repos.plugins.addEvent(ownerId, {
            pluginId,
            kind: 'uninstalled',
            version: record.version,
            detail: purgeData ? 'data removed' : 'data kept',
        });
        this.options.onItemsChanged?.(ownerId);
    }

    events(ownerId: string, pluginId: string, page: { cursor?: string | undefined; limit: number }) {
        return this.options.repos.plugins.listEvents(ownerId, { pluginId, ...page });
    }

    /** 外连清单用:已启用插件授权的域名(第 3.3 节,PR 3 起会真正使用)。 */
    egressDomains(ownerId: string): { pluginId: string; name: string; domain: string; enabled: boolean }[] {
        const out: { pluginId: string; name: string; domain: string; enabled: boolean }[] = [];
        for (const record of this.options.repos.plugins.list(ownerId)) {
            if (record.state === 'uninstalled') continue;
            const manifest = record.manifest as PluginManifest;
            for (const domain of manifest.permissions.net) {
                out.push({
                    pluginId: record.pluginId,
                    name: manifest.name.en ?? manifest.name['zh-CN'] ?? record.pluginId,
                    domain,
                    enabled: record.state === 'enabled',
                });
            }
        }
        return out;
    }
}

export { parsePluginManifest };
