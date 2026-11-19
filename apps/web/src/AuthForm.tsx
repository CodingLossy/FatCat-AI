// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { type FormEvent, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';

function Brand({ tagline }: { tagline: string }) {
    return (
        <header className="auth-brand">
            <img className="auth-logo" src="/icons/icon-192.png" alt="" width="64" height="64" />
            <h1>FatCat-AI</h1>
            <p className="muted">{tagline}</p>
        </header>
    );
}

/** 提交按钮:忙时显示转圈。 */
function SubmitButton({ busy, children }: { busy: boolean; children: string }) {
    return (
        <button type="submit" className="primary" disabled={busy} aria-busy={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {children}
        </button>
    );
}

/** 首次启动的初始化表单,或已初始化后的登录表单。 */
export function AuthForm({ initialized, onDone }: { initialized: boolean; onDone: () => Promise<void> }) {
    const { t } = useI18n();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [setupCode, setSetupCode] = useState('');
    const [showPassword, setShowPassword] = useState(false);
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
                <Brand tagline={t('app.tagline')} />
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
                    <SubmitButton busy={busy}>{t('auth.totpSubmit')}</SubmitButton>
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
            <Brand tagline={t('app.tagline')} />
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
                <div className="auth-field">
                    <label>
                        {t('auth.password')}
                        <input
                            name="password"
                            type={showPassword ? 'text' : 'password'}
                            autoComplete={initialized ? 'current-password' : 'new-password'}
                            aria-invalid={error ? true : undefined}
                            minLength={12}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </label>
                    <button
                        type="button"
                        className="auth-toggle"
                        aria-pressed={showPassword}
                        onClick={() => setShowPassword(!showPassword)}
                    >
                        {showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                    </button>
                </div>
                {initialized ? null : (
                    <label>
                        {t('auth.setupCode')}
                        <input
                            name="setupCode"
                            autoComplete="off"
                            aria-describedby="setup-code-hint"
                            value={setupCode}
                            onChange={(e) => setSetupCode(e.target.value)}
                        />
                        <span id="setup-code-hint" className="muted small auth-hint">
                            {t('auth.setupCodeHint')}
                        </span>
                    </label>
                )}
                {error ? <p className="error">{error}</p> : null}
                <SubmitButton busy={busy}>{initialized ? t('auth.submitLogin') : t('auth.submitSetup')}</SubmitButton>
            </form>
        </main>
    );
}
