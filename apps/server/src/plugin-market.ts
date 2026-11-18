// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件市场的索引缓存与浏览(ADR 0040 第 5.2、5.3 节)。索引只在用户打开市场页或点「刷新」时下载,
// 不定时拉取,请求里不带任何标识。验证通过的索引连同签名存在 `<数据目录>/plugins/.market/<市场>.json` 与 `.sig`,
// 每次读取缓存都重新验签,文件被改过就当作没有缓存。新索引的 serial 不能小于缓存的(防回滚),过期的索引不采用。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    compareSemver,
    type EgressTarget,
    parseSemver,
    type PluginIndex,
    type PluginMarketListing,
    type PluginMarketPluginView,
    type PluginMarketStatus,
    type PluginState,
    satisfiesEngine,
} from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import {
    fetchIndexFiles,
    type MarketConfig,
    MarketError,
    officialMarket,
    verifyIndex,
    type VerifiedIndex,
} from '@fatcat-ai/tools/market';
import { ApiError } from './errors.js';

/** 取索引与包时用的网络检查;生产里是默认值,测试里指向本机的假服务器。 */
export type MarketNet = Pick<NonNullable<Parameters<typeof fetchIndexFiles>[1]>, 'resolve' | 'isBlocked'>;

export interface MarketServiceOptions {
    repos: Repositories;
    dataDir: string;
    /** 默认只有内置的官方市场;用户自己加的市场只能写在 config.yaml(第 5.2 节,还没有读取器)。 */
    markets?: readonly MarketConfig[];
    net?: MarketNet;
    now?: () => Date;
    log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

interface Cache {
    verified: VerifiedIndex;
    fetchedAt: string;
}

interface State {
    cache: Cache | null;
    error: { code: string; message: string } | null;
}

/** 当前核心版本(判断 `engines`)与已安装的插件(列表里标出)由调用方传入。 */
export interface MarketContext {
    coreVersion: string;
    installed: (pluginId: string) => { version: string; state: PluginState } | null;
}

export class MarketService {
    private readonly cacheDir: string;
    private readonly states = new Map<string, State>();
    private readonly inFlight = new Map<string, Promise<void>>();
    /** 已配置的市场;官方市场内置,默认只有它。 */
    readonly markets: readonly MarketConfig[];

    constructor(private readonly options: MarketServiceOptions) {
        this.cacheDir = join(options.dataDir, 'plugins', '.market');
        this.markets = options.markets ?? [officialMarket()];
    }

    private now(): Date {
        return this.options.now?.() ?? new Date();
    }

    enabled(ownerId: string): boolean {
        return this.options.repos.settings.get(ownerId).plugins?.marketEnabled !== false;
    }

    private requireEnabled(ownerId: string): void {
        if (!this.enabled(ownerId)) {
            throw new ApiError(409, 'market_disabled', 'Conflict', 'The plugin market is turned off in Settings.');
        }
    }

    private netFor(ownerId: string) {
        const settings = this.options.repos.settings.get(ownerId);
        return {
            allowFakeIp: settings.network?.allowFakeIp === true,
            ...this.options.net,
        };
    }

    /** 给安装器下载包用的网络参数(同一套:net-guard、fake-IP 开关)。 */
    downloadNet(ownerId: string) {
        return this.netFor(ownerId);
    }

    // ───────────── 缓存 ─────────────

    private state(market: MarketConfig): State {
        let state = this.states.get(market.id);
        if (!state) {
            state = { cache: null, error: null };
            this.states.set(market.id, state);
            state.cache = this.readCache(market);
        }
        return state;
    }

    private paths(id: string) {
        return { index: join(this.cacheDir, `${id}.json`), sig: join(this.cacheDir, `${id}.sig`) };
    }

    /** 读缓存并重新验签;文件缺失、被改动或公钥已不在列表里都当作没有缓存。同步读取,文件很小。 */
    private readCache(market: MarketConfig): Cache | null {
        const paths = this.paths(market.id);
        if (!existsSync(paths.index) || !existsSync(paths.sig)) return null;
        try {
            const verified = verifyIndex(readFileSync(paths.index), readFileSync(paths.sig), market.keys, market.id);
            return { verified, fetchedAt: statSync(paths.index).mtime.toISOString() };
        } catch {
            return null;
        }
    }

    private writeCache(market: MarketConfig, index: Buffer, signature: Buffer): void {
        mkdirSync(this.cacheDir, { recursive: true });
        const paths = this.paths(market.id);
        // 先写临时文件再改名:中途失败时旧缓存不受影响;先换索引再换签名之间的短暂不一致由读取时的验签兜住
        for (const [path, bytes] of [
            [paths.index, index],
            [paths.sig, signature],
        ] as const) {
            const tmp = `${path}.tmp`;
            writeFileSync(tmp, bytes);
            renameSync(tmp, path);
        }
    }

    private expired(cache: Cache): boolean {
        return Date.parse(cache.verified.index.expiresAt) <= this.now().getTime();
    }

    // ───────────── 刷新 ─────────────

    /** 下载并验证每个已配置市场的索引。关闭市场时不发任何请求。失败只记在状态里,不抛错。 */
    async refresh(ownerId: string): Promise<void> {
        this.requireEnabled(ownerId);
        await Promise.all(this.markets.map((market) => this.refreshOne(ownerId, market)));
    }

    private refreshOne(ownerId: string, market: MarketConfig): Promise<void> {
        const running = this.inFlight.get(market.id);
        if (running) return running;
        const task = this.doRefresh(ownerId, market).finally(() => this.inFlight.delete(market.id));
        this.inFlight.set(market.id, task);
        return task;
    }

    private async doRefresh(ownerId: string, market: MarketConfig): Promise<void> {
        const state = this.state(market);
        try {
            const files = await fetchIndexFiles(market, this.netFor(ownerId));
            const verified = verifyIndex(files.index, files.signature, market.keys, market.id);
            const { index } = verified;
            if (state.cache && index.serial < state.cache.verified.index.serial) {
                throw new MarketError(
                    'index_rollback',
                    `the index serial ${index.serial} is older than the cached ${state.cache.verified.index.serial}`,
                );
            }
            if (Date.parse(index.expiresAt) <= this.now().getTime()) {
                throw new MarketError('index_expired', `the index expired at ${index.expiresAt}`);
            }
            this.writeCache(market, files.index, files.signature);
            state.cache = { verified, fetchedAt: this.now().toISOString() };
            state.error = null;
            this.options.log?.info(
                { market: market.id, serial: index.serial, keyId: verified.keyId },
                'plugin index updated',
            );
        } catch (error) {
            const failure =
                error instanceof MarketError
                    ? error
                    : new MarketError('index_download_failed', error instanceof Error ? error.message : 'failed');
            state.error = { code: failure.code, message: failure.message };
            // 下载失败(网络)不算事件;签名、格式、回滚、过期这类「内容被拒绝」要留下记录
            if (failure.code !== 'index_download_failed') {
                this.options.repos.plugins.addEvent(ownerId, {
                    pluginId: `market:${market.id}`,
                    kind: 'market-rejected',
                    detail: failure.code,
                });
            }
            this.options.log?.warn({ market: market.id, code: failure.code }, 'plugin index was not updated');
        }
    }

    // ───────────── 读取 ─────────────

    private status(market: MarketConfig): PluginMarketStatus {
        const state = this.state(market);
        const cache = state.cache;
        const base = {
            id: market.id,
            official: market.official,
            keyId: cache?.verified.keyId ?? null,
            serial: cache?.verified.index.serial ?? null,
            fetchedAt: cache?.fetchedAt ?? null,
            expiresAt: cache?.verified.index.expiresAt ?? null,
        };
        if (!cache) return { ...base, state: 'unavailable', error: state.error };
        if (this.expired(cache)) {
            return {
                ...base,
                state: 'unavailable',
                error: {
                    code: 'index_expired',
                    message: `the cached index expired at ${cache.verified.index.expiresAt}; refresh to get a new one`,
                },
            };
        }
        return { ...base, state: state.error ? 'stale' : 'ok', error: state.error };
    }

    listing(ownerId: string, context: MarketContext): PluginMarketListing {
        this.requireEnabled(ownerId);
        const plugins: PluginMarketPluginView[] = [];
        for (const market of this.markets) {
            const cache = this.state(market).cache;
            if (!cache || this.expired(cache)) continue;
            for (const entry of cache.verified.index.plugins) {
                const versions = entry.versions
                    .filter((v) => !v.yanked)
                    .sort((a, b) => compareSemver(parseSemver(b.version)!, parseSemver(a.version)!))
                    .map((v) => ({
                        version: v.version,
                        engines: v.engines.fatcat,
                        size: v.size,
                        publishedAt: v.publishedAt,
                        permissions: v.permissions,
                        compatible: satisfiesEngine(context.coreVersion, v.engines.fatcat),
                    }));
                if (versions.length === 0) continue;
                plugins.push({
                    market: market.id,
                    id: entry.id,
                    name: entry.name,
                    description: entry.description,
                    author: entry.author,
                    license: entry.license,
                    homepage: entry.homepage ?? null,
                    versions,
                    installed: context.installed(entry.id),
                });
            }
        }
        return { markets: this.markets.map((m) => this.status(m)), plugins };
    }

    /**
     * 安装前取一个已验证、未过期的索引条目。市场关闭、没有可用索引、找不到版本、版本已下架都拒绝。
     * 返回的 `index` 是当时缓存里的那份:下载地址、大小、sha256 与 downloadHosts 都只来自它。
     */
    resolve(
        ownerId: string,
        marketId: string,
        pluginId: string,
        version: string,
    ): {
        market: MarketConfig;
        keyId: string;
        index: PluginIndex;
        entry: PluginIndex['plugins'][number];
        version: PluginIndex['plugins'][number]['versions'][number];
    } {
        this.requireEnabled(ownerId);
        const market = this.markets.find((m) => m.id === marketId);
        if (!market) throw new ApiError(404, 'not_found', 'Not Found', `Market ${marketId} was not found.`);
        const cache = this.state(market).cache;
        if (!cache || this.expired(cache)) {
            throw new ApiError(
                503,
                'market_unavailable',
                'Service Unavailable',
                'There is no valid index for this market. Refresh the market and try again.',
            );
        }
        const entry = cache.verified.index.plugins.find((p) => p.id === pluginId);
        const found = entry?.versions.find((v) => v.version === version);
        if (!entry || !found) throw new ApiError(404, 'not_found', 'Not Found', 'That plugin version is not listed.');
        if (found.yanked) {
            throw new ApiError(
                409,
                'plugin_yanked',
                'Conflict',
                `This version was withdrawn: ${found.yankedReason ?? 'no reason given'}.`,
            );
        }
        return { market, keyId: cache.verified.keyId, index: cache.verified.index, entry, version: found };
    }

    /**
     * 已安装的市场插件被索引下架时返回原因(缓存里的索引,即使已过期也用:下架的版本不会因为索引过期而变安全);
     * 没有被下架、不是市场来源或没有缓存时 null。
     */
    yankedReason(sourceRef: string): string | null {
        const match = /^([a-z][a-z0-9-]{0,31}):([a-z][a-z0-9-]{1,31})@(.+)$/.exec(sourceRef);
        if (!match) return null;
        const market = this.markets.find((m) => m.id === match[1]);
        if (!market) return null;
        const found = this.state(market)
            .cache?.verified.index.plugins.find((p) => p.id === match[2])
            ?.versions.find((v) => v.version === match[3]);
        return found?.yanked ? (found.yankedReason ?? 'withdrawn') : null;
    }

    /** 外连清单(第 5.3 节):每个市场的索引地址与(缓存里的)索引声明的包下载主机。关闭市场时一项也没有。 */
    egressTargets(ownerId: string): EgressTarget[] {
        if (!this.enabled(ownerId)) return [];
        const targets: EgressTarget[] = [];
        for (const market of this.markets) {
            const hosts = new Set<string>([new URL(market.indexUrl).hostname, ...(market.indexHosts ?? [])]);
            for (const host of this.state(market).cache?.verified.index.downloadHosts ?? []) hosts.add(host);
            for (const host of hosts) {
                targets.push({
                    id: `plugin-market:${market.id}:${host}`,
                    category: 'plugin',
                    label: `Plugin market ${market.id}`,
                    origin: `https://${host}`,
                    local: false,
                    source: { kind: 'plugin-market', id: market.id },
                    enabled: true,
                });
            }
        }
        return targets;
    }
}
