// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Session, Settings } from '@ai-personal/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { ApprovalPanel } from './ApprovalPanel.js';
import { AuditPage } from './AuditPage.js';
import { ChatView } from './ChatView.js';
import { ItemsPage } from './ItemsPage.js';
import { MailPage } from './MailPage.js';
import { useI18n } from './i18n.js';
import { MemoryPage } from './MemoryPage.js';
import { navigate, routePath, useRoute, type Route } from './router.js';
import { SettingsPage } from './SettingsPage.js';

function Link({ to, className, children }: { to: Route; className?: string; children: React.ReactNode }) {
    return (
        <a
            href={routePath(to)}
            className={className}
            onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                navigate(to);
            }}
        >
            {children}
        </a>
    );
}

export function Shell({
    settings,
    onSettings,
    onLogout,
}: {
    settings: Settings;
    onSettings: (s: Settings) => void;
    onLogout: () => Promise<void>;
}) {
    const { t } = useI18n();
    const route = useRoute();
    const [sessions, setSessions] = useState<Session[]>([]);

    const reloadSessions = useCallback(
        () =>
            api.sessions
                .list({ limit: 100 })
                .then((page) => setSessions(page.items))
                .catch(() => undefined),
        [],
    );

    useEffect(() => {
        let alive = true;
        api.sessions
            .list({ limit: 100 })
            .then((page) => alive && setSessions(page.items))
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, []);

    const activeId = route.name === 'session' ? route.id : null;

    return (
        <div className="shell">
            <aside className="sidebar">
                <Link to={{ name: 'home' }} className="button primary new-chat">
                    {t('nav.newChat')}
                </Link>
                <nav className="session-list" aria-label="sessions">
                    {sessions.length === 0 ? <p className="muted small">{t('nav.noSessions')}</p> : null}
                    {sessions.map((s) => (
                        <Link
                            key={s.id}
                            to={{ name: 'session', id: s.id }}
                            className={`session-link${s.id === activeId ? ' active' : ''}`}
                        >
                            {s.title || t('nav.untitled')}
                        </Link>
                    ))}
                </nav>
                <div className="sidebar-foot">
                    <Link to={{ name: 'items' }} className={route.name === 'items' ? 'active' : ''}>
                        {t('nav.items')}
                    </Link>
                    <Link to={{ name: 'mail' }} className={route.name === 'mail' ? 'active' : ''}>
                        {t('nav.mail')}
                    </Link>
                    <Link to={{ name: 'memory' }} className={route.name === 'memory' ? 'active' : ''}>
                        {t('nav.memory')}
                    </Link>
                    <Link to={{ name: 'audit' }} className={route.name === 'audit' ? 'active' : ''}>
                        {t('nav.audit')}
                    </Link>
                    <Link to={{ name: 'settings' }} className={route.name === 'settings' ? 'active' : ''}>
                        {t('nav.settings')}
                    </Link>
                    <button type="button" className="link" onClick={() => void onLogout()}>
                        {t('auth.logout')}
                    </button>
                </div>
            </aside>
            <main className="content">
                <ApprovalPanel currentSessionId={activeId} />
                {route.name === 'settings' ? (
                    <SettingsPage settings={settings} onSettings={onSettings} />
                ) : route.name === 'memory' ? (
                    <MemoryPage />
                ) : route.name === 'audit' ? (
                    <AuditPage />
                ) : route.name === 'items' ? (
                    <ItemsPage />
                ) : route.name === 'mail' ? (
                    <MailPage />
                ) : (
                    <ChatView key={activeId ?? 'new'} sessionId={activeId} onSessionsChanged={reloadSessions} />
                )}
            </main>
        </div>
    );
}
