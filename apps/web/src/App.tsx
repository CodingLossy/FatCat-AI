// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { AuthStatus, MetaResponse, Settings } from '@ai-personal/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText } from './api.js';
import { AuthForm } from './AuthForm.js';
import { Footer } from './Footer.js';
import { I18nContext, translator, type Locale } from './i18n.js';
import { Shell } from './Shell.js';

function browserLocale(): Locale {
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** 主题写到 <html data-theme>;system 时交给 prefers-color-scheme。 */
function applyTheme(theme: Settings['theme']): void {
    document.documentElement.dataset.theme = theme;
}

async function loadAuth(): Promise<{ status: AuthStatus; settings: Settings | null }> {
    const status = await api.auth.status();
    return { status, settings: status.authenticated ? await api.settings.get() : null };
}

export function App() {
    const [meta, setMeta] = useState<MetaResponse | null>(null);
    const [status, setStatus] = useState<AuthStatus | null>(null);
    const [settings, setSettings] = useState<Settings | null>(null);
    const [error, setError] = useState<string | null>(null);

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
        api.meta()
            .then(setMeta)
            .catch(() => setMeta(null));
        loadAuth().then(
            (r) => {
                setStatus(r.status);
                setSettings(r.settings);
            },
            (e: unknown) => setError(errorText(e)),
        );
    }, []);

    useEffect(() => {
        applyTheme(settings?.theme ?? 'system');
        document.documentElement.lang = locale;
    }, [settings?.theme, locale]);

    const logout = async () => {
        await api.auth.logout().catch(() => undefined);
        await refresh();
    };

    let body;
    if (error) body = <p className="error page-message">{i18n.t('common.error', { msg: error })}</p>;
    else if (!status) body = <p className="muted page-message">{i18n.t('common.loading')}</p>;
    else if (!status.authenticated) body = <AuthForm initialized={status.initialized} onDone={refresh} />;
    else if (settings) body = <Shell settings={settings} onSettings={setSettings} onLogout={logout} />;
    else body = <p className="muted page-message">{i18n.t('common.loading')}</p>;

    return (
        <I18nContext.Provider value={i18n}>
            <div className="layout">
                {body}
                <Footer meta={meta} />
            </div>
        </I18nContext.Provider>
    );
}
