// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Session } from '@fatcat-ai/shared';
import { forkForest } from '@fatcat-ai/ui';
import { useEffect, useMemo, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { MapView } from './MapView.js';
import { navigate } from './router.js';

const MAX_SESSIONS = 1000;

/** 会话地图(ADR 0044 第 6 节):有 fork 关系的会话画成森林;点击选中,双击 / Enter 打开会话,可定位到分叉点的消息,也能跳到知识地图。 */
export function SessionMapPage() {
    const { t } = useI18n();
    const [sessions, setSessions] = useState<Session[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(() =>
        new URLSearchParams(window.location.search).get('focus'),
    );

    useEffect(() => {
        let alive = true;
        (async () => {
            const all: Session[] = [];
            let cursor: string | undefined;
            do {
                const page = await api.sessions.list({ limit: 200, ...(cursor ? { cursor } : {}) });
                all.push(...page.items);
                cursor = page.nextCursor ?? undefined;
            } while (cursor && all.length < MAX_SESSIONS);
            if (alive) setSessions(all);
        })().catch((e: unknown) => alive && setError(errorText(e)));
        return () => {
            alive = false;
        };
    }, []);

    const layout = useMemo(() => forkForest(sessions ?? []), [sessions]);
    const chosen = sessions?.find((s) => s.id === selected) ?? null;
    const parent = chosen?.forkedFromSessionId ? sessions?.find((s) => s.id === chosen.forkedFromSessionId) : undefined;

    const openSession = (id: string) => navigate({ name: 'session', id });
    const showInKnowledgeMap = (id: string) => {
        window.history.pushState(null, '', `/items?session=${encodeURIComponent(id)}`);
        navigate({ name: 'items' });
    };

    return (
        <div className="page">
            <h1>{t('sessionMap.title')}</h1>
            <p className="muted small">{t('sessionMap.hint')}</p>
            {error ? <p className="error">{error}</p> : null}
            {sessions === null && !error ? <p className="muted">{t('common.loading')}</p> : null}
            {sessions && layout.nodes.length === 0 ? <p className="muted">{t('sessionMap.empty')}</p> : null}
            {layout.nodes.length > 0 ? (
                <section className="card">
                    <MapView
                        layout={layout}
                        selectedId={selected}
                        onSelect={setSelected}
                        onOpen={openSession}
                        label={t('sessionMap.aria')}
                    />
                    <ul className="legend small">
                        <li>
                            <span className="swatch" style={{ background: 'var(--map-session)' }} />
                            {t('sessionMap.root')}
                        </li>
                        <li>
                            <span className="swatch" style={{ background: 'var(--map-fork)' }} />
                            {t('sessionMap.fork')}
                        </li>
                    </ul>
                    {layout.standalone > 0 ? (
                        <p className="small muted">
                            {t('sessionMap.standalone').replace('{n}', String(layout.standalone))}
                        </p>
                    ) : null}
                </section>
            ) : null}
            {chosen ? (
                <section className="card" role="status">
                    <h2>{chosen.title || '—'}</h2>
                    <div className="row">
                        <button type="button" className="primary" onClick={() => openSession(chosen.id)}>
                            {t('sessionMap.open')}
                        </button>
                        {parent && chosen.forkedFromMessageId ? (
                            <button
                                type="button"
                                onClick={() => {
                                    window.history.pushState(
                                        null,
                                        '',
                                        `/s/${parent.id}?m=${chosen.forkedFromMessageId}`,
                                    );
                                    navigate({ name: 'session', id: parent.id });
                                }}
                            >
                                {t('sessionMap.forkPoint').replace('{title}', parent.title || '—')}
                            </button>
                        ) : null}
                        <button type="button" onClick={() => showInKnowledgeMap(chosen.id)}>
                            {t('sessionMap.inKnowledgeMap')}
                        </button>
                    </div>
                </section>
            ) : null}
        </div>
    );
}
