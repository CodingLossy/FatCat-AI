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

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            if (initialized) await api.auth.login({ username, password });
            else await api.auth.setup({ username, password, ...(setupCode ? { setupCode } : {}) });
            setPassword('');
            await onDone();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="auth">
            <h1>AI-Personal</h1>
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
