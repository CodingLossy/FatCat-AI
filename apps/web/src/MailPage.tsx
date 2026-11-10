// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 最简邮件页(M3 方案 PR 4):账户、只读邮件列表与正文、草稿。邮件内容是不可信数据,一律按纯文本显示。
import type { MailAccount, MailDraft, MailMessage } from '@ai-personal/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { navigate } from './router.js';

/** 「问 AI」:新建会话,把建议的第一句话放进输入框(只含邮件 id,不含邮件里的文字)。 */
export async function askAboutMail(messageId: string): Promise<void> {
    const { sessionId, prompt } = await api.mail.ask(messageId);
    try {
        sessionStorage.setItem(`aip.prefill.${sessionId}`, prompt);
    } catch {
        // 不能写 sessionStorage 时只是没有预填
    }
    navigate({ name: 'session', id: sessionId });
}

function who(m: MailMessage): string {
    return m.from ? (m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address) : '?';
}

export function MailPage() {
    const { t } = useI18n();
    const [accounts, setAccounts] = useState<MailAccount[]>([]);
    const [accountId, setAccountId] = useState<string>('');
    const [folder, setFolder] = useState<'inbox' | 'sent'>('inbox');
    const [messages, setMessages] = useState<MailMessage[]>([]);
    const [open, setOpen] = useState<MailMessage | null>(null);
    const [drafts, setDrafts] = useState<MailDraft[]>([]);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const run = async (action: () => Promise<unknown>) => {
        setError(null);
        try {
            await action();
        } catch (e) {
            setError(errorText(e));
        }
    };

    const reload = useCallback(
        () =>
            Promise.all([
                api.mail.accounts.list(),
                api.mail.drafts.list(),
                api.mail.messages({ ...(accountId ? { accountId } : {}), folder, limit: 50 }),
            ]).then(([a, d, page]) => {
                setAccounts(a.items);
                setDrafts(d.items);
                setMessages(page.items);
            }),
        [accountId, folder],
    );

    useEffect(() => {
        void reload().catch((e: unknown) => setError(errorText(e)));
    }, [reload]);

    const more = () =>
        run(async () => {
            const last = messages.at(-1);
            if (!last) return;
            const page = await api.mail.messages({
                ...(accountId ? { accountId } : {}),
                folder,
                before: last.date,
                limit: 50,
            });
            setMessages([...messages, ...page.items]);
        });

    const sync = () =>
        run(async () => {
            for (const a of accounts.filter((x) => !accountId || x.id === accountId)) {
                const r = await api.mail.accounts.sync(a.id);
                setNote(r.ok ? t('mail.synced', { added: r.added }) : (r.error ?? ''));
            }
            await reload();
        });

    return (
        <div className="page mail-page">
            <h1>{t('mail.title')}</h1>
            <p className="muted small">{t('mail.hint')}</p>
            {error ? <p className="error">{error}</p> : null}
            {note ? <p className="small muted">{note}</p> : null}
            {accounts.length === 0 ? (
                <p className="muted">{t('mail.noAccounts')}</p>
            ) : (
                <div className="row">
                    <select
                        aria-label={t('mail.account')}
                        value={accountId}
                        onChange={(e) => setAccountId(e.target.value)}
                    >
                        <option value="">{t('mail.allAccounts')}</option>
                        {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                                {a.label}
                            </option>
                        ))}
                    </select>
                    <select
                        aria-label={t('mail.folder')}
                        value={folder}
                        onChange={(e) => setFolder(e.target.value as 'inbox' | 'sent')}
                    >
                        <option value="inbox">{t('mail.inbox')}</option>
                        <option value="sent">{t('mail.sent')}</option>
                    </select>
                    <button type="button" onClick={() => void sync()}>
                        {t('mail.syncNow')}
                    </button>
                </div>
            )}
            <div className="mail-layout">
                <ul className="list mail-list">
                    {messages.map((m) => (
                        <li key={m.id}>
                            <button
                                type="button"
                                className={`link mail-row${open?.id === m.id ? ' active' : ''}${m.unread ? ' unread' : ''}`}
                                onClick={() => void run(async () => setOpen(await api.mail.message(m.id)))}
                            >
                                <span className="mail-subject">{m.subject || t('mail.noSubject')}</span>
                                <span className="small muted">
                                    {who(m)} · {new Date(m.date).toLocaleString()}
                                </span>
                            </button>
                        </li>
                    ))}
                    {messages.length >= 50 ? (
                        <li>
                            <button type="button" className="link small" onClick={() => void more()}>
                                {t('items.more')}
                            </button>
                        </li>
                    ) : null}
                </ul>
                <section className="mail-view" aria-live="polite">
                    {open ? (
                        <>
                            <h2>{open.subject || t('mail.noSubject')}</h2>
                            <p className="small muted">
                                {who(open)} → {open.to.map((a) => a.address).join(', ')}
                                {open.cc.length ? ` · cc ${open.cc.map((a) => a.address).join(', ')}` : ''} ·{' '}
                                {new Date(open.date).toLocaleString()}
                            </p>
                            <div className="row">
                                <button
                                    type="button"
                                    className="primary"
                                    onClick={() => void run(() => askAboutMail(open.id))}
                                >
                                    {t('mail.ask')}
                                </button>
                            </div>
                            {open.attachments.length ? (
                                <ul className="list">
                                    {open.attachments.map((a) => (
                                        <li key={a.id} className="row spread">
                                            <span>
                                                {a.filename} <span className="small muted">({a.size} B)</span>
                                            </span>
                                            <button
                                                type="button"
                                                disabled={a.downloaded}
                                                onClick={() =>
                                                    void run(async () => {
                                                        const r = await api.mail.addAttachmentToKnowledgeBase(a.id);
                                                        setNote(
                                                            r.error
                                                                ? t('mail.kbFailed', { msg: r.error })
                                                                : t('mail.kbAdded', { n: r.chunks }),
                                                        );
                                                        setOpen(await api.mail.message(open.id));
                                                    })
                                                }
                                            >
                                                {a.downloaded ? t('mail.inKb') : t('mail.addToKb')}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            ) : null}
                            {/* 不可信内容:纯文本,不渲染 HTML 或 Markdown */}
                            <pre className="item-text">{open.text ?? ''}</pre>
                        </>
                    ) : (
                        <p className="muted">{t('mail.pick')}</p>
                    )}
                </section>
            </div>
            <Drafts drafts={drafts} onChanged={() => void run(reload)} />
        </div>
    );
}

function Drafts({ drafts, onChanged }: { drafts: MailDraft[]; onChanged: () => void }) {
    const { t } = useI18n();
    const [editing, setEditing] = useState<MailDraft | null>(null);
    const [error, setError] = useState<string | null>(null);
    if (drafts.length === 0) return null;
    const save = async () => {
        if (!editing) return;
        try {
            await api.mail.drafts.update(editing.id, {
                to: editing.to,
                cc: editing.cc,
                subject: editing.subject,
                text: editing.text,
            });
            setEditing(null);
            onChanged();
        } catch (e) {
            setError(errorText(e));
        }
    };
    return (
        <section>
            <h2>{t('mail.drafts')}</h2>
            <p className="muted small">{t('mail.draftsHint')}</p>
            {error ? <p className="error">{error}</p> : null}
            <ul className="list">
                {drafts.map((d) =>
                    editing?.id === d.id ? (
                        <li key={d.id} className="card form">
                            <input
                                aria-label={t('mail.to')}
                                value={editing.to.join(', ')}
                                onChange={(e) =>
                                    setEditing({ ...editing, to: e.target.value.split(/[,;\s]+/).filter(Boolean) })
                                }
                            />
                            <input
                                aria-label={t('mail.subject')}
                                value={editing.subject}
                                onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
                            />
                            <textarea
                                aria-label={t('mail.body')}
                                rows={8}
                                value={editing.text}
                                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                            />
                            <div className="row">
                                <button type="button" className="primary" onClick={() => void save()}>
                                    {t('mail.save')}
                                </button>
                                <button type="button" onClick={() => setEditing(null)}>
                                    {t('mail.cancel')}
                                </button>
                            </div>
                        </li>
                    ) : (
                        <li key={d.id} className="card row spread">
                            <div>
                                <strong>{d.subject || t('mail.noSubject')}</strong>
                                <div className="small muted">
                                    → {d.to.join(', ')} · {new Date(d.updatedAt).toLocaleString()}
                                </div>
                            </div>
                            <div className="row">
                                <button type="button" onClick={() => setEditing(d)}>
                                    {t('mail.edit')}
                                </button>
                                <button
                                    type="button"
                                    className="danger"
                                    onClick={() =>
                                        void api.mail.drafts
                                            .remove(d.id)
                                            .then(onChanged)
                                            .catch((e: unknown) => setError(errorText(e)))
                                    }
                                >
                                    {t('mail.delete')}
                                </button>
                            </div>
                        </li>
                    ),
                )}
            </ul>
        </section>
    );
}
