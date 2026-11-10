// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Preauthorization } from '@fatcat-ai/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';

/** 设置页中的预授权列表:查看并撤销(ADR 0010 第 3 节)。 */
export function Preauthorizations() {
    const { t, locale } = useI18n();
    const [items, setItems] = useState<Preauthorization[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(
        () =>
            api.preauthorizations
                .list()
                .then((page) => setItems(page.items))
                .catch((e: unknown) => setError(errorText(e))),
        [],
    );

    useEffect(() => {
        let alive = true;
        api.preauthorizations
            .list()
            .then((page) => alive && setItems(page.items))
            .catch((e: unknown) => alive && setError(errorText(e)));
        return () => {
            alive = false;
        };
    }, []);

    const revoke = async (p: Preauthorization) => {
        if (!window.confirm(t('preauth.revokeConfirm', { tool: p.toolName }))) return;
        try {
            await api.preauthorizations.revoke(p.id);
        } catch (e) {
            setError(errorText(e));
        }
        await reload();
    };

    return (
        <section>
            <h2>{t('preauth.title')}</h2>
            <p className="muted small">{t('preauth.hint')}</p>
            {error ? <p className="error">{error}</p> : null}
            {items?.length === 0 ? <p className="muted">{t('preauth.empty')}</p> : null}
            <ul className="list">
                {items?.map((p) => (
                    <li key={p.id} className="card row spread" data-preauth={p.toolName}>
                        <div>
                            <strong>{p.toolName}</strong>{' '}
                            <span className="small muted">
                                {p.scope === 'always' ? t('tool.rememberAlways') : t('tool.rememberSession')}
                                {p.constraint?.pathPrefix ? ` · ${p.constraint.pathPrefix}` : ''}
                                {p.constraint?.domain ? ` · ${p.constraint.domain}` : ''}
                                {' · '}
                                {p.lastUsedAt
                                    ? t('preauth.lastUsed', { time: new Date(p.lastUsedAt).toLocaleString(locale) })
                                    : t('preauth.neverUsed')}
                            </span>
                        </div>
                        <button type="button" className="danger" onClick={() => void revoke(p)}>
                            {t('preauth.revoke')}
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}
