// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Session, Settings } from '@fatcat-ai/shared';
import { Icon } from './Icon.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from './api.js';
import { ApprovalPanel } from './ApprovalPanel.js';
import { AgentsPage } from './AgentsPage.js';
import { SessionMapPage } from './SessionMapPage.js';
import { AuditPage } from './AuditPage.js';
import { cachedSessions, clearCache, isOffline, isUnauthorized, refreshCache } from './cache.js';
import { ChatView } from './ChatView.js';
import { ItemsPage } from './ItemsPage.js';
import { MailPage } from './MailPage.js';
import { PluginsPage } from './PluginsPage.js';
import { TasksPage } from './TasksPage.js';
import { useI18n } from './i18n.js';
import { MemoryPage } from './MemoryPage.js';
import { useInstallPrompt } from './pwa.js';
import { navigate, routePath, useRoute, type Route } from './router.js';
import { SettingsPage } from './SettingsPage.js';
import { useBrowserShell } from './browser-session.js';
import { Workbench } from './Workbench.js';

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

/** 工作台从 900px 起替换侧栏;更窄的宽度保留原来的抽屉(手机单栏是后续 PR)。 */
function useWideWorkbench(): boolean {
    const [wide, setWide] = useState(() => window.matchMedia('(min-width: 900px)').matches);
    useEffect(() => {
        const mq = window.matchMedia('(min-width: 900px)');
        const update = () => setWide(mq.matches);
        update();
        mq.addEventListener('change', update);
        return () => mq.removeEventListener('change', update);
    }, []);
    return wide;
}

export function Shell({
    settings,
    onSettings,
    onLogout,
    serverVersion,
}: {
    settings: Settings;
    onSettings: (s: Settings) => void;
    onLogout: () => Promise<void>;
    serverVersion: string | null;
}) {
    const wide = useWideWorkbench();
    // 桌面壳里:接收内置浏览器的页面事件,并响应服务器请求的截图
    useBrowserShell();
    const { t } = useI18n();
    const { canInstall, install } = useInstallPrompt();
    const route = useRoute();
    const [sessions, setSessions] = useState<Session[]>([]);
    const [approvalCount, setApprovalCount] = useState(0);
    // 页面标题带上待批数量,切到别的标签页也能看到
    useEffect(() => {
        document.title = approvalCount > 0 ? `(${approvalCount}) FatCat-AI` : 'FatCat-AI';
    }, [approvalCount]);
    const [sessionError, setSessionError] = useState<string | null>(null);
    const [pending, setPending] = useState<{ kind: 'one'; id: string } | { kind: 'all' } | null>(null);
    // 手机宽度:侧栏收成抽屉。记下打开时所在的路由:换页后两者不相等,抽屉自动关闭;按 Esc 也会关闭。
    // 桌面宽度下这个状态没有视觉效果。
    const routeKey = routePath(route);
    const [navOpenAt, setNavOpenAt] = useState<string | null>(null);
    const navOpen = navOpenAt === routeKey;
    const setNavOpen = (open: boolean) => setNavOpenAt(open ? routeKey : null);
    const menuRef = useRef<HTMLButtonElement>(null);
    const sidebarRef = useRef<HTMLElement>(null);
    // 抽屉打开时把焦点移到侧栏里第一个可聚焦元素;Esc 或点遮罩关闭时焦点回到「菜单」按钮(换页关闭时不抢焦点)
    useEffect(() => {
        if (!navOpen) return;
        // 抽屉的 visibility 有过渡:打开的那一帧还不可聚焦,等过渡开始后再聚焦
        const timer = window.setTimeout(() => sidebarRef.current?.querySelector<HTMLElement>('a, button')?.focus(), 50);
        return () => window.clearTimeout(timer);
    }, [navOpen]);
    useEffect(() => {
        if (!navOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setNavOpenAt(null);
                menuRef.current?.focus();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [navOpen]);

    /** 联网时读服务器并在后台追平离线缓存;连不上服务器时给出缓存里的会话;其他错误返回 null(保持现状)。 */
    const loadSessions = useCallback(async (): Promise<Session[] | null> => {
        try {
            const page = await api.sessions.list({ limit: 100 });
            void refreshCache();
            return page.items;
        } catch (error) {
            if (isUnauthorized(error)) void clearCache();
            if (!isOffline(error)) return null;
            const cached = await cachedSessions();
            return cached.length > 0 ? cached.slice(0, 100) : null;
        }
    }, []);
    const reloadSessions = useCallback(
        () => loadSessions().then((items) => (items ? setSessions(items) : undefined)),
        [loadSessions],
    );

    useEffect(() => {
        let alive = true;
        void loadSessions().then((items) => alive && items && setSessions(items));
        return () => {
            alive = false;
        };
    }, [loadSessions]);

    // 网络恢复后刷新一次
    useEffect(() => {
        const onOnline = () => void reloadSessions();
        window.addEventListener('online', onOnline);
        return () => window.removeEventListener('online', onOnline);
    }, [reloadSessions]);

    const activeId = route.name === 'session' ? route.id : null;

    const deleteSession = async (id: string) => {
        try {
            await api.sessions.delete(id);
            setSessionError(null);
            setPending(null);
            await reloadSessions();
            if (activeId === id) navigate({ name: 'home' });
        } catch (e) {
            setSessionError(errorText(e));
        }
    };

    const clearSessions = async () => {
        try {
            await api.sessions.clear();
            setSessionError(null);
            setPending(null);
            await reloadSessions();
            if (activeId) navigate({ name: 'home' });
        } catch (e) {
            setSessionError(errorText(e));
        }
    };

    // 设置、邮件、任务等页面:宽屏时放进工作台(同一侧栏、主题与面板),窄屏仍在抽屉布局里
    const page =
        route.name === 'settings' ? (
            <SettingsPage settings={settings} onSettings={onSettings} />
        ) : route.name === 'memory' ? (
            <MemoryPage settings={settings} onSettings={onSettings} />
        ) : route.name === 'audit' ? (
            <AuditPage />
        ) : route.name === 'items' ? (
            <ItemsPage />
        ) : route.name === 'mail' ? (
            <MailPage />
        ) : route.name === 'tasks' ? (
            <TasksPage />
        ) : route.name === 'plugins' ? (
            <PluginsPage />
        ) : route.name === 'agents' ? (
            <AgentsPage />
        ) : route.name === 'session-map' ? (
            <SessionMapPage />
        ) : null;

    if (wide) {
        return (
            <Workbench
                serverVersion={serverVersion}
                settings={settings}
                onSettings={onSettings}
                onLogout={onLogout}
                sessions={sessions}
                onDeleteSession={deleteSession}
                onClearSessions={clearSessions}
                onSessionsChanged={reloadSessions}
                onApprovalCount={setApprovalCount}
                pageView={page}
            />
        );
    }

    return (
        <div className="shell">
            <header className="topbar">
                <button
                    type="button"
                    className="topbar-menu"
                    ref={menuRef}
                    aria-expanded={navOpen}
                    aria-controls="sidebar"
                    onClick={() => setNavOpen(!navOpen)}
                >
                    {t('nav.menu')}
                </button>
                <img className="brand-logo" src="/icons/app-icon.svg" alt="" width={24} height={24} />
                <span className="topbar-title">FatCat-AI</span>
                {canInstall ? (
                    <button type="button" className="button small" onClick={() => void install()}>
                        {t('pwa.install')}
                    </button>
                ) : null}
            </header>

            {navOpen ? (
                <div
                    className="sidebar-backdrop"
                    onClick={() => {
                        setNavOpen(false);
                        menuRef.current?.focus();
                    }}
                    aria-hidden="true"
                />
            ) : null}
            <aside
                id="sidebar"
                ref={sidebarRef}
                className={`sidebar${navOpen ? ' open' : ''}`}
                // 点了指向当前页的链接时路由不变,抽屉不会因换页而关闭,这里补上
                onClick={(e) => {
                    if (navOpen && (e.target as HTMLElement).closest('a')) setNavOpenAt(null);
                }}
            >
                <div className="sidebar-brand">
                    <img className="brand-logo" src="/icons/app-icon.svg" alt="" width={28} height={28} />
                    <span>FatCat-AI</span>
                </div>
                <Link to={{ name: 'home' }} className="button primary new-chat">
                    <Icon name="chat" size={16} />
                    {t('nav.newChat')}
                </Link>
                <nav className="session-list" aria-label="sessions">
                    {sessions.length === 0 ? <p className="muted small">{t('nav.noSessions')}</p> : null}
                    {sessions.map((s) => (
                        <div key={s.id} className="session-row">
                            <Link
                                to={{ name: 'session', id: s.id }}
                                className={`session-link${s.id === activeId ? ' active' : ''}`}
                            >
                                {s.title || t('nav.untitled')}
                            </Link>
                            <button
                                type="button"
                                className="link small"
                                aria-label={`${t('chat.delete')}: ${s.title || t('nav.untitled')}`}
                                onClick={() => setPending({ kind: 'one', id: s.id })}
                            >
                                {t('nav.deleteSession')}
                            </button>
                        </div>
                    ))}
                </nav>
                {sessionError ? <p className="error small">{sessionError}</p> : null}
                <button
                    type="button"
                    className="link small"
                    disabled={sessions.length === 0}
                    onClick={() => setPending({ kind: 'all' })}
                >
                    {t('nav.clearSessions')}
                </button>
                {pending ? (
                    <div className="card" role="dialog" aria-labelledby="session-confirm-title">
                        <p id="session-confirm-title">
                            {pending.kind === 'all' ? t('nav.clearSessionsConfirm') : t('chat.deleteConfirm')}
                        </p>
                        <div className="row">
                            <button
                                type="button"
                                className="danger"
                                onClick={() =>
                                    void (pending.kind === 'all' ? clearSessions() : deleteSession(pending.id))
                                }
                            >
                                {t('nav.confirm')}
                            </button>
                            <button type="button" onClick={() => setPending(null)}>
                                {t('nav.cancel')}
                            </button>
                        </div>
                    </div>
                ) : null}
                <div className="sidebar-foot">
                    <Link to={{ name: 'items' }} className={route.name === 'items' ? 'active' : ''}>
                        <Icon name="globe" size={16} />
                        {t('nav.items')}
                    </Link>
                    <Link to={{ name: 'mail' }} className={route.name === 'mail' ? 'active' : ''}>
                        <Icon name="mail" size={16} />
                        {t('nav.mail')}
                    </Link>
                    <Link to={{ name: 'tasks' }} className={route.name === 'tasks' ? 'active' : ''}>
                        <Icon name="clock" size={16} />
                        {t('nav.tasks')}
                        {approvalCount > 0 ? (
                            <span
                                className="badge badge-alert"
                                aria-label={t('approvals.waiting', { n: approvalCount })}
                            >
                                {approvalCount}
                            </span>
                        ) : null}
                    </Link>
                    <Link to={{ name: 'agents' }} className={route.name === 'agents' ? 'active' : ''}>
                        <Icon name="cat" size={16} />
                        {t('nav.agents')}
                    </Link>
                    <Link to={{ name: 'plugins' }} className={route.name === 'plugins' ? 'active' : ''}>
                        <Icon name="plug" size={16} />
                        {t('nav.plugins')}
                    </Link>
                    <Link to={{ name: 'memory' }} className={route.name === 'memory' ? 'active' : ''}>
                        <Icon name="brain" size={16} />
                        {t('nav.memory')}
                    </Link>
                    <Link to={{ name: 'audit' }} className={route.name === 'audit' ? 'active' : ''}>
                        <Icon name="pulse" size={16} />
                        {t('nav.audit')}
                    </Link>
                    <Link to={{ name: 'settings' }} className={route.name === 'settings' ? 'active' : ''}>
                        <Icon name="gear" size={16} />
                        {t('nav.settings')}
                    </Link>
                    <button type="button" className="link" onClick={() => void onLogout()}>
                        {t('auth.logout')}
                    </button>
                </div>
            </aside>
            <main className="content">
                <ApprovalPanel currentSessionId={activeId} onCount={setApprovalCount} />
                {page ?? <ChatView key={activeId ?? 'new'} sessionId={activeId} onSessionsChanged={reloadSessions} />}
            </main>
        </div>
    );
}
