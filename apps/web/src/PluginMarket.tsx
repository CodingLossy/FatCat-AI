// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { type PluginMarketListing, type PluginMarketPluginView } from '@fatcat-ai/shared';
import { FatCatApiError } from '@fatcat-ai/client';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { navigate } from './router.js';
import { defaultMarketVersion, marketAction, marketErrorKey, permissionSummary, pickText } from './plugin-ui.js';

/**
 * 插件市场(ADR 0040 第 5.2、5.3 节)。打开这个页签时下载并验证一次签名的索引(只发一个 GET,不带任何标识),
 * 之后只在点「刷新」时再下载;下载失败或被拒绝时显示缓存里的旧索引并说明原因。插件给的文字一律按纯文本显示。
 */
export function PluginMarket({
    busy,
    reloadKey,
    onPrepare,
}: {
    busy: boolean;
    /** 安装或卸载后变化,让列表里的「已安装」标记更新(只读缓存,不再下载)。 */
    reloadKey: number;
    onPrepare: (market: string, id: string, version: string) => Promise<void>;
}) {
    const { t, locale } = useI18n();
    const [listing, setListing] = useState<PluginMarketListing | null>(null);
    const [disabled, setDisabled] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [choice, setChoice] = useState<Record<string, string>>({});
    const [query, setQuery] = useState('');

    const apply = useCallback((next: PluginMarketListing) => {
        setListing(next);
        setDisabled(false);
    }, []);
    const fail = useCallback((e: unknown) => {
        if (e instanceof FatCatApiError && e.problem.code === 'market_disabled') setDisabled(true);
        else setError(errorText(e));
    }, []);

    const refresh = useCallback(() => {
        setError(null);
        setLoading(true);
        return api.plugins
            .refreshMarket()
            .then(apply)
            .catch(fail)
            .finally(() => setLoading(false));
    }, [apply, fail]);

    // 打开页签:先显示缓存里的,再下载一次
    useEffect(() => {
        let alive = true;
        let refreshed = false;
        api.plugins
            .market()
            .then((l) => alive && !refreshed && apply(l))
            .catch((e: unknown) => alive && !refreshed && fail(e));
        api.plugins
            .refreshMarket()
            .then((l) => {
                refreshed = true;
                if (alive) apply(l);
            })
            .catch((e: unknown) => alive && fail(e))
            .finally(() => alive && setLoading(false));
        return () => {
            alive = false;
        };
    }, [apply, fail]);

    // 安装 / 卸载之后只重读缓存
    useEffect(() => {
        if (reloadKey === 0) return;
        api.plugins.market().then(apply).catch(fail);
    }, [reloadKey, apply, fail]);

    if (disabled) {
        return (
            <section className="card" data-testid="market-disabled">
                <p>{t('plugins.market.off')}</p>
                <button type="button" onClick={() => navigate({ name: 'settings' })}>
                    {t('plugins.market.openSettings')}
                </button>
            </section>
        );
    }

    const needle = query.trim().toLowerCase();
    const shown =
        listing?.plugins.filter(
            (p) =>
                needle === '' ||
                p.id.includes(needle) ||
                pickText(p.name, locale).toLowerCase().includes(needle) ||
                pickText(p.description, locale).toLowerCase().includes(needle),
        ) ?? [];
    const blocked = listing !== null && listing.markets.every((m) => m.state === 'unavailable');

    return (
        <div data-testid="plugin-market">
            <p className="muted small">{t('plugins.market.hint')}</p>
            {error ? <p className="error">{error}</p> : null}
            {listing?.markets.map((m) => (
                <div key={m.id} className="small" data-testid="market-status" data-state={m.state}>
                    <span className="badge" data-state={m.state}>
                        {t(`plugins.market.state.${m.state}`)}
                    </span>{' '}
                    {m.id}
                    {m.official ? ` · ${t('plugins.market.official')}` : ''}
                    {m.fetchedAt
                        ? ` · ${t('plugins.market.updated', { at: new Date(m.fetchedAt).toLocaleString(locale) })}`
                        : ''}
                    {m.keyId ? ` · ${t('plugins.market.signedBy', { keyId: m.keyId })}` : ''}
                    {m.error ? (
                        <p className={m.state === 'unavailable' ? 'error' : 'warn'}>
                            {marketErrorKey(m.error.code) ? t(marketErrorKey(m.error.code)!) : m.error.message}
                            {m.state === 'stale' && m.fetchedAt
                                ? ` ${t('plugins.market.staleNote', { at: new Date(m.fetchedAt).toLocaleString(locale) })}`
                                : ''}
                        </p>
                    ) : null}
                </div>
            ))}
            <div className="row">
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('plugins.market.search')}
                    aria-label={t('plugins.market.search')}
                />
                <button type="button" disabled={loading || busy} onClick={() => void refresh()}>
                    {loading ? t('common.loading') : t('plugins.market.refresh')}
                </button>
            </div>
            {listing && shown.length === 0 && !blocked ? <p className="muted">{t('plugins.market.empty')}</p> : null}
            <ul className="list">
                {shown.map((p) => (
                    <li key={`${p.market}:${p.id}`} className="card" data-market-plugin={p.id}>
                        <MarketEntry
                            plugin={p}
                            busy={busy || blocked}
                            selected={choice[p.id] ?? defaultMarketVersion(p.versions)}
                            onSelect={(version) => setChoice({ ...choice, [p.id]: version })}
                            onPrepare={onPrepare}
                        />
                    </li>
                ))}
            </ul>
        </div>
    );
}

function MarketEntry({
    plugin,
    busy,
    selected,
    onSelect,
    onPrepare,
}: {
    plugin: PluginMarketPluginView;
    busy: boolean;
    selected: string | null;
    onSelect: (version: string) => void;
    onPrepare: (market: string, id: string, version: string) => Promise<void>;
}) {
    const { t, locale } = useI18n();
    const version = plugin.versions.find((v) => v.version === selected) ?? plugin.versions[0];
    const installed = plugin.installed;
    const action = version ? marketAction(installed?.version ?? null, version.version) : 'none';
    return (
        <div className="row">
            <div>
                <strong>{pickText(plugin.name, locale)}</strong> <span className="small muted">{plugin.id}</span>
                {installed ? (
                    <span className="badge">{t('plugins.market.installed', { version: installed.version })}</span>
                ) : null}
                <p className="small muted">{pickText(plugin.description, locale)}</p>
                <p className="small muted">
                    {plugin.author} · {plugin.license}
                    {version ? ` · ${(version.size / 1024).toFixed(0)} KiB` : ''}
                </p>
                {version ? (
                    <p className="small muted">
                        {permissionSummary(version.permissions)
                            .map((row) => t(`plugins.market.perm.${row.key}`, { n: row.count }))
                            .join(' · ') || t('plugins.permNone')}
                    </p>
                ) : null}
                {version && !version.compatible ? (
                    <p className="small warn">{t('plugins.market.incompatible', { range: version.engines })}</p>
                ) : null}
            </div>
            <div className="row">
                <select
                    value={version?.version ?? ''}
                    onChange={(e) => onSelect(e.target.value)}
                    aria-label={t('plugins.market.version')}
                >
                    {plugin.versions.map((v) => (
                        <option key={v.version} value={v.version}>
                            v{v.version}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    disabled={busy || !version || !version.compatible || action === 'none'}
                    title={action === 'none' && installed ? t('plugins.market.alreadyInstalledHint') : undefined}
                    onClick={() => version && void onPrepare(plugin.market, plugin.id, version.version)}
                >
                    {action === 'upgrade' ? t('plugins.market.reviewUpgrade') : t('plugins.market.review')}
                </button>
            </div>
        </div>
    );
}
