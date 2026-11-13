// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置页「安全」一节(ADR 0027):启用 / 关闭两步验证、恢复码。二维码在浏览器里本地生成。
// 共享密钥与恢复码只在对应响应里出现一次,界面不缓存、不写入存储;关闭或离开后即丢弃。
import type { TotpSetup, TotpStatus } from '@fatcat-ai/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { QrCode } from './QrCode.js';

type Mode =
    | { kind: 'idle' }
    | { kind: 'password' }
    | { kind: 'verify'; setup: TotpSetup }
    | { kind: 'codes'; codes: string[] }
    | { kind: 'disable' }
    | { kind: 'regenerate' };

/** 把 32 个字符的密钥分成 4 个一组,方便手动输入。 */
const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

export function TotpSection() {
    const { t } = useI18n();
    const [status, setStatus] = useState<TotpStatus | null>(null);
    const [available, setAvailable] = useState(true); // 老服务器没有这个接口:整节不显示
    const [mode, setMode] = useState<Mode>({ kind: 'idle' });
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [useRecovery, setUseRecovery] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        api.totp
            .status()
            .then((s) => alive && setStatus(s))
            .catch(() => alive && setAvailable(false));
        return () => {
            alive = false;
        };
    }, []);

    if (!available || !status) return null;

    const reset = (next: Mode = { kind: 'idle' }) => {
        setMode(next);
        setPassword('');
        setCode('');
        setUseRecovery(false);
        setError(null);
    };
    const run = async (work: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await work();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };
    const factor = () => (useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() });

    const startSetup = (e: FormEvent) => {
        e.preventDefault();
        void run(async () => {
            const setup = await api.totp.setup({ password });
            setCode('');
            setMode({ kind: 'verify', setup });
        });
    };
    const enable = (e: FormEvent) => {
        e.preventDefault();
        void run(async () => {
            const { recoveryCodes } = await api.totp.enable({ password, code: code.trim() });
            setStatus(await api.totp.status());
            reset({ kind: 'codes', codes: recoveryCodes });
        });
    };
    const disable = (e: FormEvent) => {
        e.preventDefault();
        void run(async () => {
            await api.totp.disable({ password, ...factor() });
            setStatus(await api.totp.status());
            reset();
        });
    };
    const regenerate = (e: FormEvent) => {
        e.preventDefault();
        void run(async () => {
            const { recoveryCodes } = await api.totp.recoveryCodes({ password, ...factor() });
            setStatus(await api.totp.status());
            reset({ kind: 'codes', codes: recoveryCodes });
        });
    };

    const codeInput = (
        <label>
            {useRecovery ? t('totp.recoveryCode') : t('totp.code')}
            <input
                name={useRecovery ? 'recoveryCode' : 'code'}
                autoComplete={useRecovery ? 'off' : 'one-time-code'}
                inputMode={useRecovery ? 'text' : 'numeric'}
                maxLength={useRecovery ? 11 : 6}
                placeholder={useRecovery ? 'XXXXX-XXXXX' : '123456'}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
            />
        </label>
    );
    const passwordInput = (
        <label>
            {t('auth.password')}
            <input
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
            />
        </label>
    );
    const recoveryToggle = (
        <label className="inline">
            <input
                type="checkbox"
                checked={useRecovery}
                onChange={(e) => {
                    setUseRecovery(e.target.checked);
                    setCode('');
                }}
            />{' '}
            {t('totp.useRecovery')}
        </label>
    );
    const actions = (submitLabel: string) => (
        <span className="row">
            <button type="submit" className="primary" disabled={busy}>
                {submitLabel}
            </button>
            <button type="button" disabled={busy} onClick={() => reset()}>
                {t('nav.cancel')}
            </button>
        </span>
    );
    const errorLine = error ? (
        <p className="error" role="alert">
            {error}
        </p>
    ) : null;

    return (
        <section className="card form" aria-label={t('totp.title')}>
            <h2>{t('totp.title')}</h2>
            <p className="small" data-testid="totp-state">
                {status.enabled ? t('totp.on', { n: status.recoveryCodesRemaining }) : t('totp.off')}
            </p>

            {mode.kind === 'idle' && !status.enabled ? (
                <>
                    <p className="small muted">{t('totp.hint')}</p>
                    <button type="button" onClick={() => reset({ kind: 'password' })}>
                        {t('totp.enable')}
                    </button>
                </>
            ) : null}
            {mode.kind === 'idle' && status.enabled ? (
                <span className="row">
                    <button type="button" onClick={() => reset({ kind: 'regenerate' })}>
                        {t('totp.regenerate')}
                    </button>
                    <button type="button" className="danger" onClick={() => reset({ kind: 'disable' })}>
                        {t('totp.disable')}
                    </button>
                </span>
            ) : null}

            {mode.kind === 'password' ? (
                <form className="form" onSubmit={startSetup}>
                    <p className="small">{t('totp.passwordStep')}</p>
                    {passwordInput}
                    {errorLine}
                    {actions(t('totp.next'))}
                </form>
            ) : null}

            {mode.kind === 'verify' ? (
                <form className="form" onSubmit={enable}>
                    <p className="small">{t('totp.scanStep')}</p>
                    <div className="qr-login">
                        <QrCode value={mode.setup.otpauthUri} label={t('totp.qrLabel')} size={200} />
                        <p className="small">
                            {t('totp.manual')} <code data-testid="totp-secret">{grouped(mode.setup.secret)}</code>
                        </p>
                    </div>
                    {codeInput}
                    {errorLine}
                    <p className="small muted">{t('totp.enableNote')}</p>
                    {actions(t('totp.confirmEnable'))}
                </form>
            ) : null}

            {mode.kind === 'codes' ? (
                <div role="group" aria-label={t('totp.codesTitle')}>
                    <h3>{t('totp.codesTitle')}</h3>
                    <p className="warning small">{t('totp.codesWarning')}</p>
                    <ul className="recovery-codes" data-testid="recovery-codes">
                        {mode.codes.map((c) => (
                            <li key={c}>
                                <code>{c}</code>
                            </li>
                        ))}
                    </ul>
                    <span className="row">
                        <button
                            type="button"
                            onClick={() => void navigator.clipboard?.writeText(mode.codes.join('\n'))}
                        >
                            {t('chat.copy')}
                        </button>
                        <button type="button" className="primary" onClick={() => reset()}>
                            {t('totp.savedCodes')}
                        </button>
                    </span>
                </div>
            ) : null}

            {mode.kind === 'disable' ? (
                <form className="form" onSubmit={disable}>
                    <p className="small">{t('totp.disableStep')}</p>
                    {passwordInput}
                    {codeInput}
                    {recoveryToggle}
                    {errorLine}
                    {actions(t('totp.confirmDisable'))}
                </form>
            ) : null}

            {mode.kind === 'regenerate' ? (
                <form className="form" onSubmit={regenerate}>
                    <p className="small">{t('totp.regenerateStep')}</p>
                    {passwordInput}
                    {codeInput}
                    {recoveryToggle}
                    {errorLine}
                    {actions(t('totp.confirmRegenerate'))}
                </form>
            ) : null}

            <p className="small muted">{t('totp.resetHint')}</p>
        </section>
    );
}
