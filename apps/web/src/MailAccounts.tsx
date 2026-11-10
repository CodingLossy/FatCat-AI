// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置页中的邮件账户(ADR 0016 第 1 节):只填密码引用(env:NAME 或 file:NAME),不接收明文密码。
import type { MailAccount, MailPreset, MailSentCopy } from '@fatcat-ai/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { sentCopyDuplicate, sentCopyNote } from './sent-copy.js';

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
    const next = { ...record };
    delete next[key];
    return next;
}

const SENT_COPY: MailSentCopy[] = ['auto', 'append', 'off'];

export function MailAccounts() {
    const { t } = useI18n();
    const [items, setItems] = useState<MailAccount[]>([]);
    const [presets, setPresets] = useState<MailPreset[]>([]);
    const [preset, setPreset] = useState('');
    const [label, setLabel] = useState('');
    const [address, setAddress] = useState('');
    const [passwordRef, setPasswordRef] = useState('');
    const [result, setResult] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    /** 正在保存的账户:控件禁用,直到服务器返回并重新读取列表。 */
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    /** 每个账户自己的操作错误,显示在对应卡片里。 */
    const [cardError, setCardError] = useState<Record<string, string>>({});

    const reload = useCallback(
        () =>
            api.mail.accounts
                .list()
                .then((page) => setItems(page.items))
                .catch((e: unknown) => setError(errorText(e))),
        [],
    );
    useEffect(() => {
        void reload();
        api.mail
            .presets()
            .then((p) => {
                setPresets(p.items);
                setPreset(p.items[0]?.id ?? '');
            })
            .catch(() => undefined);
    }, [reload]);

    const run = async (action: () => Promise<unknown>) => {
        setError(null);
        try {
            await action();
        } catch (e) {
            setError(errorText(e));
        }
        await reload();
    };

    /** 针对某个账户的操作:保存期间禁用该卡片的控件,失败时把错误显示在这张卡片里。 */
    const runFor = async (id: string, action: () => Promise<unknown>) => {
        setBusy((b) => ({ ...b, [id]: true }));
        setCardError((c) => without(c, id));
        try {
            await action();
        } catch (e) {
            setCardError((c) => ({ ...c, [id]: errorText(e) }));
        }
        await reload();
        setBusy((b) => without(b, id));
    };

    const chosen = presets.find((p) => p.id === preset);
    const add = (e: FormEvent) => {
        e.preventDefault();
        if (!chosen) return;
        void run(async () => {
            await api.mail.accounts.add({
                label: label.trim() || chosen.label,
                address: address.trim(),
                username: address.trim(),
                passwordRef: passwordRef.trim(),
                imap: chosen.imap,
                smtp: chosen.smtp,
                // 不传 appendToSent / sentCopy:策略为 auto,由服务器按主机决定(ADR 0016 第 14 节)
            });
            setLabel('');
            setAddress('');
            setPasswordRef('');
        });
    };

    const test = (a: MailAccount) =>
        runFor(a.id, async () => {
            const r = await api.mail.accounts.test(a.id);
            const part = (name: string, c: { ok: boolean; error: string | null }) =>
                `${name}: ${c.ok ? t('mail.ok') : (c.error ?? '')}`;
            setResult({ ...result, [a.id]: `${part('IMAP', r.imap)} · ${part('SMTP', r.smtp)}` });
        });

    const remove = (a: MailAccount) => {
        if (!window.confirm(t('mail.removeConfirm', { name: a.label }))) return;
        void run(() => api.mail.accounts.remove(a.id));
    };

    return (
        <section>
            <h2>{t('mail.accounts')}</h2>
            <p className="muted small">{t('mail.accountsHint')}</p>
            {error ? <p className="error">{error}</p> : null}
            <ul className="list">
                {items.map((a) => (
                    <li key={a.id} className="card row spread" data-mail-account={a.address}>
                        <div>
                            <strong>{a.label}</strong>
                            <span className="small muted"> · {a.address}</span>
                            <div className="small muted">
                                {a.passwordStatus === 'missing'
                                    ? t('mail.passwordMissing', { ref: a.passwordRef })
                                    : a.passwordRef}
                                {a.lastSyncedAt
                                    ? ` · ${t('mail.lastSync', { time: new Date(a.lastSyncedAt).toLocaleString() })}`
                                    : ''}
                            </div>
                            <label className="small">
                                {t('mail.sentCopy')}{' '}
                                <select
                                    name="sentCopy"
                                    value={a.sentCopy}
                                    disabled={busy[a.id] === true}
                                    onChange={(e) =>
                                        void runFor(a.id, () =>
                                            api.mail.accounts.update(a.id, {
                                                sentCopy: e.target.value as MailSentCopy,
                                            }),
                                        )
                                    }
                                >
                                    {SENT_COPY.map((v) => (
                                        <option key={v} value={v}>
                                            {t(`mail.sentCopy.${v}`)}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <div className="small muted" data-testid="sent-copy-effect">
                                {t(sentCopyNote(a))}
                            </div>
                            {sentCopyDuplicate(a, presets) ? (
                                <div className="small warning" role="status" data-testid="sent-copy-duplicate">
                                    {t('mail.sentCopyDuplicate')}
                                </div>
                            ) : null}
                            {cardError[a.id] ? (
                                <div className="small error" role="alert" data-testid="mail-account-error">
                                    {cardError[a.id]}
                                </div>
                            ) : null}
                            {a.lastError ? <div className="small error">{a.lastError}</div> : null}
                            {result[a.id] ? <div className="small">{result[a.id]}</div> : null}
                        </div>
                        <div className="row">
                            <button type="button" disabled={busy[a.id] === true} onClick={() => void test(a)}>
                                {t('mail.test')}
                            </button>
                            <button
                                type="button"
                                disabled={busy[a.id] === true}
                                onClick={() =>
                                    void runFor(a.id, () => api.mail.accounts.update(a.id, { enabled: !a.enabled }))
                                }
                            >
                                {a.enabled ? t('mcp.disable') : t('mcp.enable')}
                            </button>
                            <button type="button" className="danger" onClick={() => remove(a)}>
                                {t('mcp.remove')}
                            </button>
                        </div>
                    </li>
                ))}
            </ul>
            <form className="card form" onSubmit={add}>
                <select aria-label={t('mail.provider')} value={preset} onChange={(e) => setPreset(e.target.value)}>
                    {presets.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.label}
                        </option>
                    ))}
                </select>
                {chosen ? <p className="small muted">{chosen.help}</p> : null}
                <input
                    aria-label={t('mail.label')}
                    placeholder={t('mail.label')}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                />
                <input
                    aria-label={t('mail.address')}
                    placeholder={t('mail.address')}
                    type="email"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    required
                />
                <input
                    aria-label={t('mail.passwordRef')}
                    placeholder="env:MAIL_PASSWORD"
                    value={passwordRef}
                    onChange={(e) => setPasswordRef(e.target.value)}
                    pattern="(env|file):[A-Za-z_][A-Za-z0-9_]{0,63}"
                    spellCheck={false}
                    required
                />
                <button type="submit" className="primary">
                    {t('mcp.add')}
                </button>
            </form>
        </section>
    );
}
