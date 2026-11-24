// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { MetaResponse, Session, Settings } from '@fatcat-ai/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { AgentsPage } from './AgentsPage.js';
import { SessionMapPage } from './SessionMapPage.js';
import { AuditPage } from './AuditPage.js';
import { useConversation } from './conversation.js';
import { useI18n } from './i18n.js';
import { cachedSessions, clearCache, isOffline, isUnauthorized, refreshCache } from './cache.js';
import { ItemsPage } from './ItemsPage.js';
import { KnowledgePage } from './KnowledgePage.js';
import { MailPage } from './MailPage.js';
import { PluginsPage } from './PluginsPage.js';
import { TasksPage } from './TasksPage.js';
import { MemoryPage } from './MemoryPage.js';
import { navigate, useRoute } from './router.js';
import { SettingsPage } from './SettingsPage.js';
import { useBrowserShell } from './browser-session.js';
import { Workbench } from './Workbench.js';

/** 900px 起是宽屏工作台,更窄时是手机单栏(同一个工作台,底部标签栏、侧栏收进抽屉)。 */
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
    meta = null,
}: {
    settings: Settings;
    onSettings: (s: Settings) => void;
    onLogout: () => Promise<void>;
    serverVersion: string | null;
    meta?: MetaResponse | null;
}) {
    const wide = useWideWorkbench();
    // 桌面壳里:接收内置浏览器的页面事件,并响应服务器请求的截图
    useBrowserShell();
    const route = useRoute();
    const [sessions, setSessions] = useState<Session[]>([]);
    const [approvalCount, setApprovalCount] = useState(0);
    // 页面标题带上待批数量,切到别的标签页也能看到
    // 连续对话开着时标题带上「麦克风开着」(ADR 0049 第 2.2 节),桌面应用的窗口标题跟着变
    const micOn = useConversation().active;
    const { t } = useI18n();
    useEffect(() => {
        const base = approvalCount > 0 ? `(${approvalCount}) FatCat-AI` : 'FatCat-AI';
        document.title = micOn ? `${t('voice.micOnTitle')} ${base}` : base;
    }, [approvalCount, micOn, t]);
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
            await reloadSessions();
            if (activeId === id) navigate({ name: 'home' });
        } catch {
            // 删除失败时列表保持原样
        }
    };

    const clearSessions = async () => {
        try {
            await api.sessions.clear();
            await reloadSessions();
            if (activeId) navigate({ name: 'home' });
        } catch {
            // 删除失败时列表保持原样
        }
    };

    // 设置、邮件、任务等页面:宽屏时放进工作台(同一侧栏、主题与面板),窄屏仍在抽屉布局里
    const page =
        route.name === 'settings' ? (
            <SettingsPage settings={settings} onSettings={onSettings} />
        ) : route.name === 'knowledge' ? (
            <KnowledgePage settings={settings} onSettings={onSettings} />
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

    return (
        <Workbench
            serverVersion={serverVersion}
            meta={meta}
            narrow={!wide}
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
