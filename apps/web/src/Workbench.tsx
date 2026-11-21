// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 桌面宽度的工作台(ui-redesign.md 第 5 节):顶栏、左侧舞台、导轨和面板。
// 900px 以下仍用原来的侧栏,手机单栏在后面的 PR 里做。
import type { Item, Session, Settings } from '@fatcat-ai/shared';
import type { IconName } from '@fatcat-ai/ui/icons';
import {
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from 'react';
import { api, errorText } from './api.js';
import { ApprovalPanel } from './ApprovalPanel.js';
import { BrowserPanel } from './BrowserPanel.js';
import { browserController } from './browser-session.js';
import { ChatView, type ChatActivity } from './ChatView.js';
import { FileTree, PreviewBody } from './FilePanel.js';
import {
    buildWorkspace,
    languageOf,
    latestFetchedPage,
    latestWrite,
    markControls,
    type FilePreview,
} from './file-workspace.js';
import { Icon } from './Icon.js';
import { useI18n, type Key } from './i18n.js';
import { MailPage } from './MailPage.js';
import { MemoryPage } from './MemoryPage.js';
import { navigate, routePath, useRoute, type Route } from './router.js';
import {
    initialPanel,
    matchCommands,
    reducePanel,
    toolsFromTranscript,
    visibleToolRows,
    type ToolRowStatus,
    type WorkbenchPanel,
} from './workbench-model.js';

function Link({
    to,
    className,
    label,
    children,
}: {
    to: Route;
    className?: string;
    label: string;
    children: ReactNode;
}) {
    return (
        <a
            href={routePath(to)}
            className={className}
            aria-label={label}
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

const RAIL_PANELS: { id: WorkbenchPanel; icon: IconName; label: Key }[] = [
    { id: 'files', icon: 'files', label: 'wb.rail.files' },
    { id: 'search', icon: 'search', label: 'wb.rail.search' },
    { id: 'changes', icon: 'diff', label: 'wb.rail.changes' },
    { id: 'mail', icon: 'mail', label: 'nav.mail' },
    { id: 'memory', icon: 'brain', label: 'nav.memory' },
    { id: 'browser', icon: 'globe', label: 'wb.rail.browser' },
];

const PAGE_LINKS: { to: Route; icon: IconName; label: Key }[] = [
    { to: { name: 'settings' }, icon: 'gear', label: 'nav.settings' },
    { to: { name: 'plugins' }, icon: 'plug', label: 'nav.plugins' },
    { to: { name: 'items' }, icon: 'folder', label: 'nav.items' },
    { to: { name: 'tasks' }, icon: 'clock', label: 'nav.tasks' },
    { to: { name: 'agents' }, icon: 'cat', label: 'nav.agents' },
    { to: { name: 'audit' }, icon: 'pulse', label: 'nav.audit' },
];

function statusIcon(status: ToolRowStatus): IconName | null {
    if (status === 'done') return 'check';
    if (status === 'failed') return 'x';
    if (status === 'waiting') return 'clock';
    return null;
}

export function Workbench({
    serverVersion,
    settings,
    onSettings,
    onLogout,
    sessions,
    onDeleteSession,
    onClearSessions,
    onSessionsChanged,
    onApprovalCount,
}: {
    serverVersion: string | null;
    settings: Settings;
    onSettings: (s: Settings) => void;
    onLogout: () => Promise<void>;
    sessions: Session[];
    onDeleteSession: (id: string) => Promise<void>;
    onClearSessions: () => Promise<void>;
    onSessionsChanged: () => Promise<void>;
    onApprovalCount: (n: number) => void;
}) {
    const { t } = useI18n();
    const route = useRoute();
    const sessionId = route.name === 'session' ? route.id : null;
    const [activity, setActivity] = useState<ChatActivity | null>(null);
    const onActivity = useCallback((next: ChatActivity) => setActivity(next), []);
    const [epoch, setEpoch] = useState(0);
    const askRef = useRef<((text: string) => Promise<void>) | null>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const [panel, dispatch] = useReducer(reducePanel, undefined, initialPanel);
    const [query, setQuery] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const [files, setFiles] = useState<Item[]>([]);
    const [cursor, setCursor] = useState(0);
    const [picked, setPicked] = useState<string | null>(null);
    const [opened, setOpened] = useState<FilePreview | null>(null);
    const [modelOpen, setModelOpen] = useState(false);
    const [coreUp, setCoreUp] = useState<boolean | null>(null);
    const [clicked, setClicked] = useState<{ path: string; line: number } | null>(null);
    const [pending, setPending] = useState<{ kind: 'one'; id: string } | { kind: 'all' } | null>(null);
    const [busy, setBusy] = useState(false);

    const tools = useMemo(() => toolsFromTranscript(activity?.messages ?? [], activity?.live ?? null), [activity]);
    const liveTools = activity?.live?.tools ?? [];
    const running = visibleToolRows(liveTools);
    const workspace = useMemo(() => buildWorkspace(tools), [tools]);
    const write = useMemo(() => latestWrite(tools), [tools]);
    const page = useMemo(() => latestFetchedPage(tools), [tools]);
    // 桌面壳里有可控制的浏览器面板;纯网页和手机上为 null,继续显示文字卡片
    const browser = browserController();
    useEffect(() => {
        if (!browser) return;
        // 服务器要截图而面板不在前台时,切到浏览器面板
        browser.onRequestPanel(() => dispatch({ type: 'pin', panel: 'browser' }));
        return () => {
            browser.onRequestPanel(() => undefined);
        };
    }, [browser]);
    // 搜索下拉、模型菜单和确认框会盖在面板上,而原生 webview 总在界面之上:这些浮层打开时先藏起来
    const overlayOpen = searchOpen || modelOpen || pending !== null;
    useEffect(() => {
        browser?.setHidden(overlayOpen);
    }, [browser, overlayOpen]);
    const selected = picked ?? workspace.selectedPath ?? opened?.path ?? null;
    const activeRow = [...running.rows].reverse().find((row) => row.status === 'running' || row.status === 'waiting');

    const latestName = liveTools.length > 0 ? liveTools[liveTools.length - 1]!.name : null;
    const runId = activity?.live?.runId ?? null;
    useEffect(() => {
        dispatch({ type: 'live', runId, toolName: latestName });
    }, [runId, latestName]);

    useEffect(() => {
        let alive = true;
        const tick = () => {
            void fetch('/healthz', { cache: 'no-store' }).then(
                (res) => alive && setCoreUp(res.ok),
                () => alive && setCoreUp(false),
            );
        };
        tick();
        const id = window.setInterval(tick, 30_000);
        return () => {
            alive = false;
            window.clearInterval(id);
        };
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                searchRef.current?.focus();
                setSearchOpen(true);
            } else if (e.key === 'Escape') {
                setModelOpen(false);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const seq = useRef(0);
    useEffect(() => {
        const q = query.trim();
        if (!q) return;
        const id = ++seq.current;
        const timer = window.setTimeout(() => {
            void api.items.search({ q, limit: 8 }).then(
                (page) => {
                    if (seq.current === id) setFiles(page.items);
                },
                () => {
                    if (seq.current === id) setFiles([]);
                },
            );
        }, 200);
        return () => window.clearTimeout(timer);
    }, [query]);

    const commands = useMemo(() => {
        const go = (target: Route) => () => navigate(target);
        const pin = (id: WorkbenchPanel) => () => dispatch({ type: 'pin', panel: id });
        const list: { id: string; label: string; keywords: string; run: () => void }[] = [
            { id: 'new', label: t('nav.newChat'), keywords: 'new chat session', run: go({ name: 'home' }) },
            { id: 'settings', label: t('wb.cmd.settings'), keywords: 'settings', run: go({ name: 'settings' }) },
            { id: 'files', label: t('wb.cmd.panel.files'), keywords: 'files', run: pin('files') },
            { id: 'search', label: t('wb.cmd.panel.search'), keywords: 'search', run: pin('search') },
            { id: 'changes', label: t('wb.cmd.panel.changes'), keywords: 'diff changes', run: pin('changes') },
            { id: 'mail', label: t('wb.cmd.panel.mail'), keywords: 'mail', run: pin('mail') },
            { id: 'memory', label: t('wb.cmd.panel.memory'), keywords: 'memory', run: go({ name: 'memory' }) },
            { id: 'browser', label: t('wb.cmd.panel.browser'), keywords: 'browser', run: pin('browser') },
            { id: 'tasks', label: t('nav.tasks'), keywords: 'tasks', run: go({ name: 'tasks' }) },
            { id: 'plugins', label: t('nav.plugins'), keywords: 'plugins', run: go({ name: 'plugins' }) },
            { id: 'agents', label: t('nav.agents'), keywords: 'agents', run: go({ name: 'agents' }) },
            { id: 'audit', label: t('nav.audit'), keywords: 'audit', run: go({ name: 'audit' }) },
            { id: 'items', label: t('nav.items'), keywords: 'items map', run: go({ name: 'items' }) },
            {
                id: 'voice',
                label: t('wb.cmd.voice'),
                keywords: 'voice speak',
                run: () => {
                    void api.settings
                        .update({ voice: { autoSpeak: !settings.voice.autoSpeak } })
                        .then(onSettings)
                        .catch(() => undefined);
                },
            },
        ];
        for (const session of sessions) {
            const title = session.title || t('nav.untitled');
            list.push({
                id: `s-${session.id}`,
                label: t('wb.cmd.session', { title }),
                keywords: title,
                run: go({ name: 'session', id: session.id }),
            });
        }
        return list;
    }, [onSettings, sessions, settings.voice.autoSpeak, t]);

    const shownFiles = query.trim() ? files : [];
    const shownCommands = matchCommands(commands, query).slice(0, 8);
    type Hit =
        | { kind: 'file'; item: Item }
        | { kind: 'command'; id: string; label: string; run: () => void }
        | { kind: 'ask' };
    const hits: Hit[] = [
        ...shownFiles.map((item) => ({ kind: 'file' as const, item })),
        ...shownCommands.map((command) => ({
            kind: 'command' as const,
            id: command.id,
            label: command.label,
            run: command.run,
        })),
        ...(query.trim() ? [{ kind: 'ask' as const }] : []),
    ];
    const activeHit = hits[Math.min(cursor, Math.max(hits.length - 1, 0))];

    const openItem = async (item: Item) => {
        dispatch({ type: 'pin', panel: 'files' });
        setSearchOpen(false);
        setQuery('');
        if (item.kind !== 'content') return;
        try {
            const content = await api.items.content(item.id);
            const path = item.sourceRef || item.title;
            setOpened({
                path,
                text: markControls(content.content),
                truncatedByTool: content.truncated,
                highlightLine: null,
            });
            setPicked(path);
        } catch (e) {
            setOpened({
                path: item.title,
                text: errorText(e),
                truncatedByTool: false,
                highlightLine: null,
            });
            setPicked(item.title);
        }
    };

    const activate = (hit: Hit | undefined) => {
        if (!hit) return;
        if (hit.kind === 'file') {
            void openItem(hit.item);
            return;
        }
        if (hit.kind === 'command') {
            setSearchOpen(false);
            setQuery('');
            hit.run();
            return;
        }
        const text = query.trim();
        setSearchOpen(false);
        setQuery('');
        void askRef.current?.(text);
    };

    const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((n) => Math.min(n + 1, Math.max(hits.length - 1, 0)));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((n) => Math.max(n - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            activate(activeHit);
        } else if (e.key === 'Escape') {
            setSearchOpen(false);
            searchRef.current?.blur();
        }
    };

    const chatProfiles = (activity?.profiles ?? []).filter((profile) => profile.purpose.includes('chat'));
    const modelLabel = activity?.profile?.label ?? t('wb.noModel');

    const chooseModel = async (id: string) => {
        setModelOpen(false);
        try {
            if (sessionId) await api.sessions.update(sessionId, { modelProfileId: id });
            else onSettings(await api.settings.update({ defaultChatProfileId: id }));
            setEpoch((n) => n + 1);
        } catch {
            // 选择失败时胶囊仍显示上一次读到的配置档
        }
    };

    const activePreview =
        (selected && workspace.previews.get(selected)) || (opened && opened.path === selected ? opened : null);
    const statusLine = clicked && clicked.path === selected ? clicked.line : (activePreview?.highlightLine ?? 1);
    const onLine = useCallback(
        (line: number) => {
            if (selected) setClicked({ path: selected, line });
        },
        [selected],
    );

    const confirmPending = async () => {
        if (!pending) return;
        setBusy(true);
        try {
            if (pending.kind === 'all') await onClearSessions();
            else await onDeleteSession(pending.id);
            setPending(null);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="shell wb-shell">
            <header className="wb-top">
                <Link to={{ name: 'home' }} className="wb-brand" label="FatCat-AI">
                    <Icon name="paw" size={24} />
                    <span>FatCat-AI{serverVersion ? <small> v{serverVersion}</small> : null}</span>
                </Link>
                <div className="wb-search">
                    <Icon name="search" size={16} />
                    <input
                        ref={searchRef}
                        value={query}
                        placeholder={t('wb.searchPlaceholder')}
                        aria-label={t('wb.searchPlaceholder')}
                        aria-expanded={searchOpen}
                        aria-controls="wb-search-list"
                        role="combobox"
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setCursor(0);
                            setSearchOpen(true);
                        }}
                        onFocus={() => setSearchOpen(true)}
                        onBlur={() => window.setTimeout(() => setSearchOpen(false), 150)}
                        onKeyDown={onSearchKey}
                    />
                    <kbd>{t('wb.kbd')}</kbd>
                    {searchOpen ? (
                        <ul className="wb-search-list" id="wb-search-list" role="listbox">
                            {hits.length === 0 ? <li className="muted">{t('wb.searchEmpty')}</li> : null}
                            {shownFiles.length > 0 ? <li className="wb-search-label">{t('wb.searchFiles')}</li> : null}
                            {hits.map((hit, index) => (
                                <li key={hit.kind === 'file' ? hit.item.id : hit.kind === 'command' ? hit.id : 'ask'}>
                                    <button
                                        type="button"
                                        role="option"
                                        aria-selected={index === cursor}
                                        className={index === cursor ? 'on' : ''}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => activate(hit)}
                                    >
                                        {hit.kind === 'file'
                                            ? hit.item.title
                                            : hit.kind === 'command'
                                              ? hit.label
                                              : t('wb.searchAsk', { q: query.trim() })}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
                <div className="wb-model">
                    <button
                        type="button"
                        className="wb-pill"
                        aria-haspopup="listbox"
                        aria-expanded={modelOpen}
                        onClick={() => setModelOpen((open) => !open)}
                    >
                        <Icon name="cat" size={16} />
                        {modelLabel}
                    </button>
                    {modelOpen ? (
                        <ul className="wb-model-menu" role="listbox">
                            {chatProfiles.length === 0 ? <li className="muted">{t('wb.noModel')}</li> : null}
                            {chatProfiles.map((profile) => (
                                <li key={profile.id}>
                                    <button
                                        type="button"
                                        role="option"
                                        aria-selected={profile.id === activity?.profile?.id}
                                        onClick={() => void chooseModel(profile.id)}
                                    >
                                        {profile.label}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
                <Link to={{ name: 'home' }} className="wb-new" label={t('nav.newChat')}>
                    {t('nav.newChat')}
                </Link>
                <button type="button" className="link small" onClick={() => void onLogout()}>
                    {t('auth.logout')}
                </button>
            </header>
            <ApprovalPanel currentSessionId={sessionId} onCount={onApprovalCount} />
            {sessions.length > 0 ? (
                <ul className="wb-sessions">
                    {sessions.map((session) => {
                        const title = session.title || t('nav.untitled');
                        return (
                            <li key={session.id}>
                                <Link
                                    to={{ name: 'session', id: session.id }}
                                    className={session.id === sessionId ? 'on' : ''}
                                    label={title}
                                >
                                    {title}
                                </Link>
                                <button
                                    type="button"
                                    className="link small"
                                    aria-label={`${t('chat.delete')}: ${title}`}
                                    onClick={() => setPending({ kind: 'one', id: session.id })}
                                >
                                    {t('nav.deleteSession')}
                                </button>
                            </li>
                        );
                    })}
                    <li>
                        <button type="button" className="link small" onClick={() => setPending({ kind: 'all' })}>
                            {t('nav.clearSessions')}
                        </button>
                    </li>
                </ul>
            ) : null}
            {pending ? (
                <div className="card wb-confirm" role="dialog">
                    <p>{pending.kind === 'all' ? t('nav.clearSessionsConfirm') : t('chat.deleteConfirm')}</p>
                    <div className="row">
                        <button type="button" className="danger" disabled={busy} onClick={() => void confirmPending()}>
                            {t('nav.confirm')}
                        </button>
                        <button type="button" onClick={() => setPending(null)}>
                            {t('nav.cancel')}
                        </button>
                    </div>
                </div>
            ) : null}
            <div className="wb">
                <section className="wb-stage">
                    <div className="wb-glass wb-running" aria-live="polite">
                        <h4>{t('wb.running')}</h4>
                        {running.hidden > 0 ? (
                            <p className="wb-more-count">{t('wb.runningMore', { n: running.hidden })}</p>
                        ) : null}
                        {running.rows.length === 0 ? <p className="muted small">{t('wb.runningEmpty')}</p> : null}
                        {running.rows.map((row) => {
                            const icon = statusIcon(row.status);
                            return (
                                <div
                                    key={row.callId}
                                    className={`wb-tool${row.callId === activeRow?.callId ? ' active' : ''}`}
                                >
                                    <span>{row.summary}</span>
                                    <span className="state">
                                        {icon ? (
                                            <Icon name={icon} size={16} />
                                        ) : (
                                            <span className="wb-spin" aria-hidden="true" />
                                        )}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                    <ChatView
                        key={sessionId ?? 'new'}
                        sessionId={sessionId}
                        onSessionsChanged={onSessionsChanged}
                        workbench
                        profileEpoch={epoch}
                        onActivity={onActivity}
                        askRef={askRef}
                    />
                </section>
                <div className="wb-right">
                    <nav className="wb-rail" aria-label={t('wb.railLabel')}>
                        {RAIL_PANELS.map((item) =>
                            item.id === 'memory' ? (
                                <Link
                                    key={item.id}
                                    to={{ name: 'memory' }}
                                    className={panel.panel === 'memory' ? 'on' : ''}
                                    label={t(item.label)}
                                >
                                    <Icon name={item.icon} size={20} />
                                </Link>
                            ) : (
                                <button
                                    key={item.id}
                                    type="button"
                                    className={panel.panel === item.id ? 'on' : ''}
                                    aria-label={t(item.label)}
                                    aria-pressed={panel.panel === item.id}
                                    onClick={() => {
                                        dispatch({ type: 'pin', panel: item.id });
                                        if (item.id === 'search') searchRef.current?.focus();
                                    }}
                                >
                                    <Icon name={item.icon} size={20} />
                                </button>
                            ),
                        )}
                        <span className="gap" />
                        {PAGE_LINKS.map((item) => (
                            <Link key={item.label} to={item.to} label={t(item.label)}>
                                <Icon name={item.icon} size={20} />
                            </Link>
                        ))}
                    </nav>
                    <div className="wb-main">
                        <div className="wb-panel">
                            {panel.panel === 'files' ? (
                                <FileTree
                                    rootLabel={workspace.rootLabel}
                                    roots={workspace.roots}
                                    previews={workspace.previews}
                                    selectedPath={selected}
                                    extra={opened}
                                    onSelect={setPicked}
                                    onLine={onLine}
                                />
                            ) : null}
                            {panel.panel === 'search' ? <p className="wb-empty">{t('wb.searchHint')}</p> : null}
                            {panel.panel === 'changes' ? (
                                write && write.text ? (
                                    <div className="wb-editor-wrap">
                                        <p className="wb-note">
                                            {t('wb.changesNote')}
                                            {write.pending ? ` ${t('wb.changesPending')}` : ''}
                                        </p>
                                        <PreviewBody
                                            path={write.path}
                                            text={write.text}
                                            truncatedByTool={false}
                                            highlightLine={null}
                                            added
                                        />
                                    </div>
                                ) : (
                                    <p className="wb-empty">{t('wb.changesEmpty')}</p>
                                )
                            ) : null}
                            {panel.panel === 'mail' ? <MailPage /> : null}
                            {panel.panel === 'memory' ? (
                                <MemoryPage settings={settings} onSettings={onSettings} />
                            ) : null}
                            {panel.panel === 'browser' ? (
                                browser ? (
                                    <BrowserPanel
                                        controller={browser}
                                        pageUrl={page?.url ?? null}
                                        fallback={
                                            page ? (
                                                <PreviewBody
                                                    path={page.url}
                                                    text={page.text}
                                                    truncatedByTool={page.truncated}
                                                    highlightLine={null}
                                                    notice={t('wb.browserUntrusted')}
                                                />
                                            ) : (
                                                <p className="wb-empty">{t('wb.browser.idle')}</p>
                                            )
                                        }
                                    />
                                ) : page ? (
                                    <PreviewBody
                                        path={page.url}
                                        text={page.text}
                                        truncatedByTool={page.truncated}
                                        highlightLine={null}
                                        notice={t('wb.browserUntrusted')}
                                    />
                                ) : (
                                    <p className="wb-empty">{t('wb.browserEmpty')}</p>
                                )
                            ) : null}
                        </div>
                        <footer className="wb-status">
                            <span>
                                <Icon name="pulse" size={16} />{' '}
                                {coreUp === false ? t('wb.statusDown') : t('wb.statusOk')}
                            </span>
                            {panel.panel === 'files' && activePreview ? (
                                <span className="r">
                                    <span>{t('wb.statusLine', { n: statusLine })}</span>
                                    <span>{languageOf(activePreview.path) ?? t('wb.lang.plain')}</span>
                                </span>
                            ) : null}
                        </footer>
                    </div>
                </div>
            </div>
        </div>
    );
}
