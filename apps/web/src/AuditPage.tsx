// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { AuditEntry } from '@ai-personal/shared';
import { useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';

const PAGE = 50;

/** 审计页(只读,ADR 0010 第 6 节):按时间倒序,可加载更多。 */
export function AuditPage() {
    const { t, locale } = useI18n();
    const [items, setItems] = useState<AuditEntry[] | null>(null);
    const [cursor, setCursor] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        api.audit
            .list({ limit: PAGE })
            .then((page) => {
                if (!alive) return;
                setItems(page.items);
                setCursor(page.nextCursor);
            })
            .catch((e: unknown) => alive && setError(errorText(e)));
        return () => {
            alive = false;
        };
    }, []);

    const more = async () => {
        if (!cursor) return;
        try {
            const page = await api.audit.list({ limit: PAGE, cursor });
            setItems((old) => [...(old ?? []), ...page.items]);
            setCursor(page.nextCursor);
        } catch (e) {
            setError(errorText(e));
        }
    };

    return (
        <div className="page">
            <h1>{t('audit.title')}</h1>
            <p className="muted small">{t('audit.hint')}</p>
            {error ? <p className="error">{error}</p> : null}
            {items === null ? <p className="muted">{t('common.loading')}</p> : null}
            {items?.length === 0 ? <p className="muted">{t('audit.empty')}</p> : null}
            {items && items.length > 0 ? (
                <table className="audit-table">
                    <thead>
                        <tr>
                            <th>{t('audit.time')}</th>
                            <th>{t('audit.tool')}</th>
                            <th>{t('audit.decision')}</th>
                            <th>{t('audit.outcome')}</th>
                            <th>{t('audit.summary')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {items.map((a) => (
                            <tr key={a.id} data-action={a.action}>
                                <td className="small">{new Date(a.at).toLocaleString(locale)}</td>
                                <td>
                                    {a.toolName ?? '—'}
                                    {a.risk ? (
                                        <span className={`badge risk-${a.risk}`}>{t(`risk.${a.risk}`)}</span>
                                    ) : null}
                                </td>
                                <td>
                                    {a.decision ? t(`audit.decision.${a.decision}`) : t(`audit.action.${a.action}`)}
                                </td>
                                <td className={a.outcome === 'error' ? 'error' : ''}>
                                    {t(`audit.outcome.${a.outcome}`)}
                                </td>
                                <td className="small">
                                    {a.summary}
                                    {a.error ? <div className="error">{a.error}</div> : null}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : null}
            {cursor ? (
                <button type="button" onClick={() => void more()}>
                    {t('audit.more')}
                </button>
            ) : null}
        </div>
    );
}
