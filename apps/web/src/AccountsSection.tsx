// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置页「账户」一节(ADR 0053 第 2、6 节):只有管理员看得到。列出账户,生成邀请码 / 重置码(明文只显示这一次),
// 改角色、停用 / 启用、删除(要输入用户名确认)、给成员分配授权文件夹(第 4.1 节)。成员调用列表得到 403,整节不显示。
import type { Account, CreatedAccountCode } from '@fatcat-ai/shared';
import { type FormEvent, Fragment, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { FsRoots } from './FsRoots.js';
import { useI18n } from './i18n.js';

/** 用量显示:B / KB / MB / GB,保留一位小数。 */
function formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export function AccountsSection() {
    const { t, locale } = useI18n();
    const [accounts, setAccounts] = useState<Account[] | null>(null);
    const [selfId, setSelfId] = useState<string | null>(null);
    const [code, setCode] = useState<(CreatedAccountCode & { username?: string }) | null>(null);
    const [deleting, setDeleting] = useState<{ id: string; confirm: string } | null>(null);
    const [foldersFor, setFoldersFor] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setAccounts((await api.admin.users.list()).accounts);
    }, []);

    useEffect(() => {
        let alive = true;
        Promise.all([api.admin.users.list(), api.auth.me()])
            .then(([list, me]) => {
                if (!alive) return;
                setAccounts(list.accounts);
                setSelfId(me.id);
            })
            .catch(() => alive && setAccounts(null)); // 不是管理员,或老服务器没有这个接口
        return () => {
            alive = false;
        };
    }, []);

    if (!accounts) return null;

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
    const invite = () => run(async () => setCode(await api.admin.users.invite()));
    const resetCode = (a: Account) =>
        run(async () => setCode({ ...(await api.admin.users.resetCode(a.id)), username: a.username }));
    const update = (id: string, body: Parameters<typeof api.admin.users.update>[1]) =>
        run(async () => {
            await api.admin.users.update(id, body);
            await load();
        });
    const submitDelete = (e: FormEvent) => {
        e.preventDefault();
        const target = deleting;
        if (!target) return;
        void run(async () => {
            await api.admin.users.remove(target.id, { confirmUsername: target.confirm.trim() });
            setDeleting(null);
            await load();
        });
    };
    const fmt = (iso: string) => new Date(iso).toLocaleString(locale);

    return (
        <section className="card form" aria-label={t('accounts.title')}>
            <h2>{t('accounts.title')}</h2>
            <p className="small muted">{t('accounts.hint')}</p>
            {error ? (
                <p className="error" role="alert">
                    {error}
                </p>
            ) : null}
            {code ? (
                <div className="account-code" data-testid="account-code">
                    <p className="small muted">
                        {code.kind === 'invite'
                            ? t('accounts.inviteHint')
                            : t('accounts.resetHint', { username: code.username ?? '' })}
                    </p>
                    <p className="pairing-code" aria-label={t('accounts.code')}>
                        {code.code}
                    </p>
                    <p className="small muted">{t('accounts.codeExpires', { at: fmt(code.expiresAt) })}</p>
                    <button type="button" onClick={() => setCode(null)}>
                        {t('accounts.close')}
                    </button>
                </div>
            ) : (
                <span className="row">
                    <button type="button" className="primary" onClick={() => void invite()} disabled={busy}>
                        {t('accounts.invite')}
                    </button>
                </span>
            )}
            <ul className="list" aria-label={t('accounts.title')}>
                {accounts.map((a) => {
                    const self = a.id === selfId;
                    return (
                        <Fragment key={a.id}>
                            <li className="row spread" data-account={a.username}>
                                <span>
                                    <strong>{a.displayName ?? a.username}</strong>
                                    {a.displayName ? <span className="small muted"> @{a.username}</span> : null}{' '}
                                    <span className="badge">
                                        {a.role === 'admin' ? t('accounts.roleAdmin') : t('accounts.roleMember')}
                                    </span>
                                    {a.disabled ? (
                                        <span className="badge badge-alert">{t('accounts.disabled')}</span>
                                    ) : null}
                                    {a.totpEnabled ? <span className="badge">{t('accounts.totp')}</span> : null}
                                    {self ? <span className="small muted"> {t('accounts.you')}</span> : null}
                                    <br />
                                    <span className="small muted">
                                        {t('accounts.createdAt', { at: fmt(a.createdAt) })}
                                        {a.usage
                                            ? ` · ${t('accounts.usage', {
                                                  attachments: formatSize(a.usage.attachmentBytes),
                                                  knowledge: formatSize(a.usage.knowledgeBytes),
                                              })}`
                                            : null}
                                    </span>
                                </span>
                                {self ? null : deleting?.id === a.id ? (
                                    <form className="account-delete" onSubmit={submitDelete}>
                                        <label className="small" htmlFor={`confirm-${a.id}`}>
                                            {t('accounts.confirmDelete', { username: a.username })}
                                        </label>
                                        <span className="row">
                                            <input
                                                id={`confirm-${a.id}`}
                                                name="confirmUsername"
                                                placeholder={a.username}
                                                autoComplete="off"
                                                value={deleting.confirm}
                                                onChange={(e) => setDeleting({ id: a.id, confirm: e.target.value })}
                                                required
                                                autoFocus
                                            />
                                            <button
                                                type="submit"
                                                className="danger"
                                                disabled={busy || deleting.confirm.trim() !== a.username}
                                            >
                                                {t('accounts.deleteNow')}
                                            </button>
                                            <button type="button" onClick={() => setDeleting(null)}>
                                                {t('accounts.cancel')}
                                            </button>
                                        </span>
                                    </form>
                                ) : (
                                    <span className="row">
                                        <button
                                            type="button"
                                            aria-expanded={foldersFor === a.id}
                                            onClick={() => setFoldersFor(foldersFor === a.id ? null : a.id)}
                                        >
                                            {foldersFor === a.id ? t('accounts.hideFolders') : t('accounts.folders')}
                                        </button>
                                        <button type="button" disabled={busy} onClick={() => void resetCode(a)}>
                                            {t('accounts.resetCode')}
                                        </button>
                                        <button
                                            type="button"
                                            disabled={busy}
                                            onClick={() =>
                                                void update(a.id, { role: a.role === 'admin' ? 'member' : 'admin' })
                                            }
                                        >
                                            {a.role === 'admin' ? t('accounts.makeMember') : t('accounts.makeAdmin')}
                                        </button>
                                        <button
                                            type="button"
                                            disabled={busy}
                                            onClick={() => void update(a.id, { disabled: !a.disabled })}
                                        >
                                            {a.disabled ? t('accounts.enable') : t('accounts.disable')}
                                        </button>
                                        <button
                                            type="button"
                                            className="danger"
                                            onClick={() => setDeleting({ id: a.id, confirm: '' })}
                                        >
                                            {t('accounts.delete')}
                                        </button>
                                    </span>
                                )}
                            </li>
                            {foldersFor === a.id && !self ? (
                                <li className="card account-folders">
                                    <FsRoots account={{ id: a.id, username: a.username }} />
                                </li>
                            ) : null}
                        </Fragment>
                    );
                })}
            </ul>
        </section>
    );
}
