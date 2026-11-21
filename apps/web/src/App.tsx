// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { AuthStatus, MetaResponse, Settings } from '@fatcat-ai/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText } from './api.js';
import { deviceAuth } from './device-session.js';
import { AuthForm } from './AuthForm.js';
import { resolveAuth } from './auth-state.js';
import { clearCache, isOffline, offlineStartup, rememberSettings } from './cache.js';
import { Footer } from './Footer.js';
import { I18nContext, translator, type Locale } from './i18n.js';
import { PairPage } from './PairPage.js';
import { useOnline } from './pwa.js';
import { DEFAULT_THEME, resolveTheme } from '@fatcat-ai/ui/theme-ids';
import { useRoute } from './router.js';
import { Shell } from './Shell.js';

function browserLocale(): Locale {
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/**
 * 主题写到 <html data-theme>;旧值(system / light / dark 等)按科技处理,不改写已存的设置。
 * 同时把 <meta name="theme-color"> 换成主题的背景色,手机的状态栏和 PWA 窗口跟着变。
 */
function applyTheme(theme: Settings['theme']): void {
    const root = document.documentElement;
    root.dataset.theme = resolveTheme(theme);
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta && bg) meta.content = bg;
}

function loadAuth(): Promise<{ status: AuthStatus; settings: Settings | null }> {
    return resolveAuth({
        status: () => api.auth.status(),
        settings: () => api.settings.get(),
        isOffline,
        device: { isPaired: () => deviceAuth.isPaired(), refresh: () => deviceAuth.refresh() },
        cache: { remember: rememberSettings, clear: clearCache, offlineStartup },
    });
}

export function App() {
    const [meta, setMeta] = useState<MetaResponse | null>(null);
    const [status, setStatus] = useState<AuthStatus | null>(null);
    const [settings, setSettings] = useState<Settings | null>(null);
    const [error, setError] = useState<string | null>(null);

    const online = useOnline();
    const route = useRoute();
    const locale = settings?.locale ?? browserLocale();
    const i18n = useMemo(() => ({ locale, t: translator(locale) }), [locale]);

    const refresh = useCallback(
        () =>
            loadAuth().then(
                (r) => {
                    setStatus(r.status);
                    setSettings(r.settings);
                    setError(null);
                },
                (e: unknown) => setError(errorText(e)),
            ),
        [],
    );

    useEffect(() => {
        // 已配对的手机:先确保 access 令牌有效,再读登录状态
        void deviceAuth
            .start()
            .then(() => loadAuth())
            .then(
                (r) => {
                    setStatus(r.status);
                    setSettings(r.settings);
                },
                (e: unknown) => setError(errorText(e)),
            );
        api.meta()
            .then(setMeta)
            .catch(() => setMeta(null));
    }, []);

    // 网络恢复后重新确认登录状态(离线时显示的是缓存)
    useEffect(() => {
        const onOnline = () => void refresh();
        window.addEventListener('online', onOnline);
        return () => window.removeEventListener('online', onOnline);
    }, [refresh]);

    useEffect(() => {
        applyTheme(settings?.theme ?? DEFAULT_THEME);
        document.documentElement.lang = locale;
    }, [settings?.theme, locale]);

    const logout = async () => {
        await clearCache();
        if (deviceAuth.isPaired()) {
            await api.devices.signOut().catch(() => undefined);
            deviceAuth.forget();
        } else await api.auth.logout().catch(() => undefined);
        await refresh();
    };

    let body;
    if (route.name === 'pair') body = <PairPage />;
    else if (error) body = <p className="error page-message">{i18n.t('common.error', { msg: error })}</p>;
    else if (!status) body = <p className="muted page-message">{i18n.t('common.loading')}</p>;
    else if (!status.authenticated) body = <AuthForm initialized={status.initialized} onDone={refresh} />;
    else if (settings)
        body = (
            <Shell
                settings={settings}
                onSettings={setSettings}
                onLogout={logout}
                serverVersion={meta?.serverVersion ?? null}
                meta={meta}
            />
        );
    else body = <p className="muted page-message">{i18n.t('common.loading')}</p>;

    return (
        <I18nContext.Provider value={i18n}>
            <div className="layout">
                {online ? null : (
                    <div className="offline-banner" role="status">
                        {i18n.t('pwa.offline')}
                    </div>
                )}
                {body}
                <Footer meta={meta} />
            </div>
        </I18nContext.Provider>
    );
}
