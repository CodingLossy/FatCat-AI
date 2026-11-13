// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { type FormEvent, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';

/** 首次启动的初始化表单,或已初始化后的登录表单。 */
export function AuthForm({ initialized, onDone }: { initialized: boolean; onDone: () => Promise<void> }) {
    const { t } = useI18n();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [setupCode, setSetupCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 密码通过且账户启用了两步验证:拿到临时凭证,等待验证码或恢复码(ADR 0027)
    const [challenge, setChallenge] = useState<string | null>(null);
    const [useRecovery, setUseRecovery] = useState(false);
    const [factor, setFactor] = useState('');

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            if (initialized) {
                const result = await api.auth.login({ username, password });
                if ('totpRequired' in result) {
                    setPassword('');
                    setChallenge(result.challengeToken);
                    return;
                }
            } else await api.auth.setup({ username, password, ...(setupCode ? { setupCode } : {}) });
            setPassword('');
            await onDone();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    const submitFactor = async (e: FormEvent) => {
        e.preventDefault();
        if (!challenge) return;
        setBusy(true);
        setError(null);
        try {
            const value = factor.trim();
            await api.auth.loginTotp({
                challengeToken: challenge,
                ...(useRecovery ? { recoveryCode: value } : { code: value }),
            });
            setChallenge(null);
            setFactor('');
            await onDone();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    if (challenge) {
        return (
            <main className="auth">
                <h1>FatCat-AI</h1>
                <p className="muted">{t('app.tagline')}</p>
                <form className="card form" onSubmit={submitFactor} aria-label={t('auth.totpTitle')}>
                    <h2>{t('auth.totpTitle')}</h2>
                    <p className="muted small">{useRecovery ? t('auth.recoveryHint') : t('auth.totpHint')}</p>
                    <label>
                        {useRecovery ? t('auth.recoveryCode') : t('auth.totpCode')}
                        {useRecovery ? (
                            <input
                                name="recoveryCode"
                                autoComplete="off"
                                autoCapitalize="characters"
                                placeholder="XXXXX-XXXXX"
                                value={factor}
                                onChange={(e) => setFactor(e.target.value)}
                                required
                                autoFocus
                            />
                        ) : (
                            <input
                                name="code"
                                autoComplete="one-time-code"
                                inputMode="numeric"
                                pattern="\d{6}"
                                maxLength={6}
                                placeholder="123456"
                                value={factor}
                                onChange={(e) => setFactor(e.target.value)}
                                required
                                autoFocus
                            />
                        )}
                    </label>
                    {error ? <p className="error">{error}</p> : null}
                    <button type="submit" className="primary" disabled={busy}>
                        {t('auth.totpSubmit')}
                    </button>
                    <span className="row">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                                setUseRecovery(!useRecovery);
                                setFactor('');
                                setError(null);
                            }}
                        >
                            {useRecovery ? t('auth.useCode') : t('auth.useRecovery')}
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                                setChallenge(null);
                                setFactor('');
                                setError(null);
                            }}
                        >
                            {t('auth.totpBack')}
                        </button>
                    </span>
                </form>
            </main>
        );
    }

    return (
        <main className="auth">
            <h1>FatCat-AI</h1>
            <p className="muted">{t('app.tagline')}</p>
            <form className="card form" onSubmit={submit}>
                <h2>{initialized ? t('auth.loginTitle') : t('auth.setupTitle')}</h2>
                {initialized ? null : <p className="muted small">{t('auth.setupHint')}</p>}
                <label>
                    {t('auth.username')}
                    <input
                        name="username"
                        autoComplete="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        required
                    />
                </label>
                <label>
                    {t('auth.password')}
                    <input
                        name="password"
                        type="password"
                        autoComplete={initialized ? 'current-password' : 'new-password'}
                        minLength={12}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                    />
                </label>
                {initialized ? null : (
                    <label>
                        {t('auth.setupCode')}
                        <input name="setupCode" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} />
                    </label>
                )}
                {error ? <p className="error">{error}</p> : null}
                <button type="submit" className="primary" disabled={busy}>
                    {initialized ? t('auth.submitLogin') : t('auth.submitSetup')}
                </button>
            </form>
        </main>
    );
}
