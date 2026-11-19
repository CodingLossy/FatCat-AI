// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 手机端配对页(ADR 0045):电脑上扫码或输入配对码,换成设备令牌后进入应用。
import { PairingCode } from '@fatcat-ai/shared';
import { type FormEvent, useState } from 'react';
import { api, errorText } from './api.js';
import { deviceAuth, unauthenticatedApi } from './device-session.js';
import { clearCache } from './cache.js';
import { useI18n } from './i18n.js';
import { takePairingCode } from './pair-code.js';

function defaultDeviceName(): string {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android';
    return '';
}

export function PairPage() {
    const { t } = useI18n();
    const [code, setCode] = useState(() =>
        takePairingCode(window.location.search, (url) => window.history.replaceState(null, '', url)),
    );
    const [name, setName] = useState(defaultDeviceName);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const paired = deviceAuth.isPaired();

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const parsed = PairingCode.safeParse(code);
        if (!parsed.success) {
            setError(t('pair.invalid'));
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const tokens = await unauthenticatedApi.devices.pair({ code: parsed.data, name: name.trim() });
            deviceAuth.adopt(tokens);
            setDone(true);
            // 整页重新加载:丢掉旧的 Cookie 模式状态,从设备令牌重新开始
            window.location.replace('/');
        } catch (err) {
            setError(errorText(err));
            setBusy(false);
        }
    };

    const signOut = async () => {
        await api.devices.signOut().catch(() => undefined);
        deviceAuth.forget();
        await clearCache();
        window.location.reload();
    };

    return (
        <main className="auth">
            <header className="auth-brand">
                <img className="auth-logo" src="/icons/icon-192.png" alt="" width="64" height="64" />
                <h1>{t('pair.title')}</h1>
                <p className="muted">{t('pair.hint')}</p>
            </header>
            <form className="card form" onSubmit={(e) => void submit(e)}>
                {paired ? <p className="muted">{t('pair.alreadyPaired')}</p> : null}
                <label className="auth-field">
                    {t('pair.code')}
                    <input
                        value={code}
                        onChange={(e) => setCode(e.target.value.toUpperCase())}
                        inputMode="text"
                        autoCapitalize="characters"
                        autoCorrect="off"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={11}
                        placeholder="XXXXX-XXXXX"
                        className="pair-code"
                        required
                    />
                </label>
                <label className="auth-field">
                    {t('pair.name')}
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={60}
                        placeholder={t('pair.namePlaceholder')}
                        required
                    />
                </label>
                {error ? (
                    <p className="error" role="alert">
                        {error}
                    </p>
                ) : null}
                {done ? <p role="status">{t('pair.done')}</p> : null}
                <button type="submit" className="primary" disabled={busy || done} aria-busy={busy}>
                    {busy ? <span className="spinner" aria-hidden="true" /> : null}
                    {t('pair.submit')}
                </button>
                {paired ? (
                    <button type="button" className="link" onClick={() => void signOut()}>
                        {t('pair.signOut')}
                    </button>
                ) : null}
            </form>
        </main>
    );
}
