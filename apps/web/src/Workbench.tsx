// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 桌面宽度的工作台(M12 重做):主视觉铺满窗口;左侧栏有展开 / 收起两态;右侧面板是浮在主视觉上的玻璃卡片,
// 空闲时不显示,工具调用或 ui.panel 时打开,运行结束 8 秒后自动收起。
// 900px 以下是手机单栏(narrow):侧栏收成抽屉,底部标签栏(对话 / 文件 / 浏览器 / 设置),面板铺满主区域,只在点标签时打开。
import type { Item, MetaResponse, Session, Settings } from '@fatcat-ai/shared';
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
import { CodePanel } from './CodePanel.js';
import { buildCodeView } from './code-panel.js';
import { browserController } from './browser-session.js';
import { ChatView, type ChatActivity } from './ChatView.js';
import { FileTree, PreviewBody } from './FilePanel.js';
import { Footer } from './Footer.js';
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
import { useInstallPrompt } from './pwa.js';
import { navigate, routePath, useRoute, type Route } from './router.js';
import {
    AUTO_CLOSE_MS,
    initialPanel,
    matchCommands,
    reducePanel,
    shouldAutoClose,
    toolsFromTranscript,
    visibleToolRows,
    type ToolRowStatus,
    type WorkbenchPanel,
} from './workbench-model.js';

function Link({
    to,
    className,
    label,
    current,
    children,
}: {
    to: Route;
    className?: string;
    label: string;
    current?: boolean;
    children: ReactNode;
}) {
    return (
        <a
            href={routePath(to)}
            className={className}
            aria-label={label}
            aria-current={current ? 'page' : undefined}
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

const SIDE_PANELS: { id: WorkbenchPanel; icon: IconName; label: Key }[] = [
    { id: 'files', icon: 'files', label: 'wb.rail.files' },
    { id: 'changes', icon: 'diff', label: 'wb.rail.changes' },
    { id: 'mail', icon: 'mail', label: 'nav.mail' },
    { id: 'memory', icon: 'brain', label: 'nav.memory' },
    { id: 'browser', icon: 'globe', label: 'wb.rail.browser' },
    { id: 'code', icon: 'terminal', label: 'wb.rail.code' },
];

const PAGE_LINKS: { to: Route; icon: IconName; label: Key }[] = [
    { to: { name: 'settings' }, icon: 'gear', label: 'nav.settings' },
    { to: { name: 'plugins' }, icon: 'plug', label: 'nav.plugins' },
    { to: { name: 'knowledge' }, icon: 'brain', label: 'nav.knowledge' },
    { to: { name: 'tasks' }, icon: 'clock', label: 'nav.tasks' },
    { to: { name: 'agents' }, icon: 'cat', label: 'nav.agents' },
    { to: { name: 'audit' }, icon: 'pulse', label: 'nav.audit' },
];

/** 手机单栏的抽屉里多一个邮件页面入口(宽屏用邮件面板)。 */
const NARROW_PAGE_LINKS: { to: Route; icon: IconName; label: Key }[] = [
    ...PAGE_LINKS.slice(0, 3),
    { to: { name: 'mail' }, icon: 'mail', label: 'nav.mail' },
    ...PAGE_LINKS.slice(3),
];

const SIDEBAR_KEY = 'fatcat.sidebar';

/** 左侧栏是否收成图标栏;记在本机浏览器里,读写失败时用展开。 */
function loadCollapsed(): boolean {
    try {
        return window.localStorage.getItem(SIDEBAR_KEY) === 'min';
    } catch {
        return false;
    }
}

function saveCollapsed(collapsed: boolean): void {
    try {
        window.localStorage.setItem(SIDEBAR_KEY, collapsed ? 'min' : 'full');
    } catch {
        // 存不下也不影响使用
    }
}

function statusIcon(status: ToolRowStatus): IconName | null {
    if (status === 'done') return 'check';
    if (status === 'failed') return 'x';
    if (status === 'waiting') return 'clock';
    return null;
}

export function Workbench({
    serverVersion,
    meta = null,
    narrow = false,
    settings,
    onSettings,
    onLogout,
    sessions,
    onDeleteSession,
    onClearSessions,
    onSessionsChanged,
    onApprovalCount,
    pageView = null,
}: {
    serverVersion: string | null;
    /** 手机单栏把页脚(许可证与源码链接)放进抽屉。 */
    meta?: MetaResponse | null;
    /** 900px 以下的手机单栏。 */
    narrow?: boolean;
    settings: Settings;
    onSettings: (s: Settings) => void;
    onLogout: () => Promise<void>;
    sessions: Session[];
    onDeleteSession: (id: string) => Promise<void>;
    onClearSessions: () => Promise<void>;
    onSessionsChanged: () => Promise<void>;
    onApprovalCount: (n: number) => void;
    /** 设置、邮件等页面:代替对话舞台显示在主区域;侧栏、搜索和面板照常可用。 */
    pageView?: ReactNode;
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
    const [collapsed, setCollapsed] = useState(loadCollapsed);
    const [approvals, setApprovals] = useState(0);
    const { canInstall, install } = useInstallPrompt();
    // 手机抽屉:记下打开时的路由,换页后自动关闭;Esc 关闭并把焦点还给「菜单」
    const routeKey = routePath(route);
    const [drawerAt, setDrawerAt] = useState<string | null>(null);
    // 语音优先的极简主界面:侧栏收进左上角的小圆 logo,和手机一样当抽屉打开(ADR 0049 第 10 节)
    const minimal = !pageView && activity?.minimal === true;
    /** 极简主界面的工作态(ADR 0049 第 10.5 节):面板打开时球缩小移到左侧,面板占右侧约 2/3;手机在 PR 5。 */
    const drawer = (narrow || minimal) && drawerAt === routeKey;
    const menuRef = useRef<HTMLButtonElement>(null);
    const sideRef = useRef<HTMLElement>(null);
    const lastSession = useRef<string | null>(null);
    useEffect(() => {
        if (sessionId) lastSession.current = sessionId;
    }, [sessionId]);
    useEffect(() => {
        if (!drawer) return;
        // 抽屉的 visibility 有过渡:打开的那一帧还不可聚焦
        const timer = window.setTimeout(() => sideRef.current?.querySelector<HTMLElement>('.wb-new')?.focus(), 50);
        return () => window.clearTimeout(timer);
    }, [drawer]);
    const closeDrawer = useCallback((refocus: boolean) => {
        setDrawerAt(null);
        if (refocus) menuRef.current?.focus();
    }, []);
    const onApprovals = useCallback(
        (n: number) => {
            setApprovals(n);
            onApprovalCount(n);
        },
        [onApprovalCount],
    );
    const toggleSidebar = useCallback(() => {
        setCollapsed((value) => {
            saveCollapsed(!value);
            return !value;
        });
    }, []);

    const tools = useMemo(() => toolsFromTranscript(activity?.messages ?? [], activity?.live ?? null), [activity]);
    const liveTools = activity?.live?.tools ?? [];
    const running = visibleToolRows(liveTools);
    const workspace = useMemo(() => buildWorkspace(tools), [tools]);
    const write = useMemo(() => latestWrite(tools), [tools]);
    const page = useMemo(() => latestFetchedPage(tools), [tools]);
    const codeEnabled = settings.code?.enabled === true;
    const codeProjects = settings.code?.projects;
    const projects = useMemo(() => codeProjects ?? [], [codeProjects]);
    const code = useMemo(() => buildCodeView(tools, projects), [tools, projects]);
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
    const overlayOpen = searchOpen || modelOpen || pending !== null || !panel.open;
    useEffect(() => {
        browser?.setHidden(overlayOpen);
    }, [browser, overlayOpen]);
    const selected = picked ?? workspace.selectedPath ?? opened?.path ?? null;
    const activeRow = [...running.rows].reverse().find((row) => row.status === 'running' || row.status === 'waiting');

    // 换到设置、邮件等页面时收起浮动面板,不挡住页面内容
    const pagePath = pageView ? routePath(route) : null;
    useEffect(() => {
        if (pagePath) dispatch({ type: 'close' });
    }, [pagePath]);

    const latest = liveTools.length > 0 ? liveTools[liveTools.length - 1]! : null;
    const latestName = latest?.name ?? null;
    const latestCallId = latest?.callId ?? null;
    const latestInput = latest?.input;
    const runId = activity?.live?.runId ?? null;
    const runActive = activity?.live != null;
    useEffect(() => {
        // 手机上面板会盖住对话,不随工具调用自动打开,只在点标签时打开
        if (narrow) return;
        dispatch({ type: 'live', runId, toolName: latestName, callId: latestCallId, input: latestInput, projects });
    }, [narrow, runId, latestName, latestCallId, latestInput, projects]);

    // 运行结束后 8 秒自动收起;固定、有待审批、或又开始新一轮时不收
    const autoClose = shouldAutoClose(panel, runActive, approvals);
    useEffect(() => {
        if (!autoClose) return;
        const timer = window.setTimeout(() => dispatch({ type: 'auto-close' }), AUTO_CLOSE_MS);
        return () => window.clearTimeout(timer);
    }, [autoClose]);

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
                setSearchOpen(true);
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
                e.preventDefault();
                toggleSidebar();
            } else if (e.key === 'Escape' && !e.defaultPrevented) {
                // 先关抽屉、菜单和搜索,再收起面板
                if (drawer) closeDrawer(true);
                else if (modelOpen) setModelOpen(false);
                else if (pending) setPending(null);
                else if (panel.open) dispatch({ type: 'close' });
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [drawer, closeDrawer, modelOpen, pending, panel.open, toggleSidebar]);

    useEffect(() => {
        if (searchOpen) searchRef.current?.focus();
    }, [searchOpen]);

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

    const chooseModel = useCallback(
        async (id: string) => {
            setModelOpen(false);
            try {
                if (sessionId) await api.sessions.update(sessionId, { modelProfileId: id });
                else onSettings(await api.settings.update({ defaultChatProfileId: id }));
                setEpoch((n) => n + 1);
            } catch {
                // 选择失败时胶囊仍显示上一次读到的配置档
            }
        },
        [onSettings, sessionId],
    );
    const commands = useMemo(() => {
        const go = (target: Route) => () => navigate(target);
        const pin = (id: WorkbenchPanel) => () => dispatch({ type: 'pin', panel: id });
        const close = () => dispatch({ type: 'close' });
        const list: { id: string; label: string; keywords: string; run: () => void }[] = [
            { id: 'new', label: t('nav.newChat'), keywords: 'new chat session', run: go({ name: 'home' }) },
            { id: 'settings', label: t('wb.cmd.settings'), keywords: 'settings', run: go({ name: 'settings' }) },
            { id: 'files', label: t('wb.cmd.panel.files'), keywords: 'files', run: pin('files') },
            { id: 'changes', label: t('wb.cmd.panel.changes'), keywords: 'diff changes', run: pin('changes') },
            { id: 'mail', label: t('wb.cmd.panel.mail'), keywords: 'mail', run: pin('mail') },
            { id: 'memory', label: t('wb.cmd.panel.memory'), keywords: 'memory', run: pin('memory') },
            { id: 'close-panel', label: t('wb.cmd.closePanel'), keywords: 'close collapse hide panel', run: close },
            { id: 'sidebar', label: t('wb.cmd.sidebar'), keywords: 'sidebar collapse expand', run: toggleSidebar },
            { id: 'browser', label: t('wb.cmd.panel.browser'), keywords: 'browser', run: pin('browser') },
            { id: 'code', label: t('wb.cmd.panel.code'), keywords: 'code git commits diff tests', run: pin('code') },
            { id: 'tasks', label: t('nav.tasks'), keywords: 'tasks', run: go({ name: 'tasks' }) },
            { id: 'plugins', label: t('nav.plugins'), keywords: 'plugins', run: go({ name: 'plugins' }) },
            { id: 'agents', label: t('nav.agents'), keywords: 'agents', run: go({ name: 'agents' }) },
            { id: 'audit', label: t('nav.audit'), keywords: 'audit', run: go({ name: 'audit' }) },
            {
                id: 'knowledge',
                label: t('nav.knowledge'),
                keywords: 'knowledge items map memory',
                run: go({ name: 'knowledge' }),
            },
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
        // 模型与代理的切换在这里(极简主界面上没有胶囊和下拉,ADR 0049 第 10 节)
        for (const profile of (activity?.profiles ?? []).filter((p) => p.purpose.includes('chat'))) {
            list.push({
                id: `model-${profile.id}`,
                label: t('wb.cmd.model', { label: profile.label }),
                keywords: `model ${profile.label}`,
                run: () => void chooseModel(profile.id),
            });
        }
        if ((activity?.agents ?? []).length > 0) {
            for (const agent of [{ id: '', name: t('agents.pickerNone') }, ...(activity?.agents ?? [])]) {
                list.push({
                    id: `agent-${agent.id || 'none'}`,
                    label: t('wb.cmd.agent', { name: agent.name }),
                    keywords: `agent ${agent.name}`,
                    run: () => activity?.chooseAgent(agent.id),
                });
            }
        }
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
    }, [activity, chooseModel, onSettings, sessions, settings.voice.autoSpeak, t, toggleSidebar]);

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
            e.preventDefault();
            setSearchOpen(false);
            searchRef.current?.blur();
        }
    };

    const chatProfiles = (activity?.profiles ?? []).filter((profile) => profile.purpose.includes('chat'));
    const modelLabel = activity?.profile?.label ?? t('wb.noModel');
    // 手机上代理选择收进模型胶囊的菜单:第一项是「不使用代理」
    const agentChoices = (activity?.agents ?? []).length
        ? [{ id: '', name: t('agents.pickerNone') }, ...(activity?.agents ?? [])]
        : [];
    const agentName = narrow ? activity?.agents.find((agent) => agent.id === activity.agentId)?.name : undefined;

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

    const panelTitle = (id: WorkbenchPanel): string => {
        const item = SIDE_PANELS.find((entry) => entry.id === id);
        return item ? t(item.label) : '';
    };
    const pageTitle: Partial<Record<Route['name'], Key>> = {
        settings: 'nav.settings',
        plugins: 'nav.plugins',
        items: 'nav.items',
        knowledge: 'nav.knowledge',
        tasks: 'nav.tasks',
        agents: 'nav.agents',
        audit: 'nav.audit',
        mail: 'nav.mail',
        memory: 'nav.memory',
    };
    const pageKey = pageView ? pageTitle[route.name] : undefined;
    const sessionTitle = pageKey
        ? t(pageKey)
        : sessions.find((session) => session.id === sessionId)?.title || t('nav.newChat');

    const sidePanels = SIDE_PANELS.filter((item) =>
        // 记忆并入「知识」入口;手机上文件、浏览器和代码在底部标签栏里;代码只在设置里打开后显示
        narrow ? item.id === 'changes' : item.id !== 'memory' && (item.id !== 'code' || codeEnabled),
    );
    const pageLinks = narrow ? NARROW_PAGE_LINKS : PAGE_LINKS;
    type TabId = 'chat' | 'files' | 'browser' | 'code' | 'settings';
    const tabs: { id: TabId; icon: IconName; label: string; on: boolean }[] = [
        { id: 'chat', icon: 'chat', label: t('wb.tab.chat'), on: !pageView && !panel.open },
        { id: 'files', icon: 'files', label: t('wb.rail.files'), on: panel.open && panel.panel === 'files' },
        { id: 'browser', icon: 'globe', label: t('wb.rail.browser'), on: panel.open && panel.panel === 'browser' },
        ...(codeEnabled
            ? [
                  {
                      id: 'code' as const,
                      icon: 'terminal' as const,
                      label: t('wb.rail.code'),
                      on: panel.open && panel.panel === 'code',
                  },
              ]
            : []),
        { id: 'settings', icon: 'gear', label: t('nav.settings'), on: route.name === 'settings' && !panel.open },
    ];
    const runTab = (id: TabId) => {
        if (id === 'files' || id === 'browser' || id === 'code') {
            dispatch({ type: 'pin', panel: id });
            return;
        }
        dispatch({ type: 'close' });
        if (id === 'settings') navigate({ name: 'settings' });
        // 从页面回到对话:回到最近一次打开的会话
        else if (pageView)
            navigate(lastSession.current ? { name: 'session', id: lastSession.current } : { name: 'home' });
    };

    return (
        <div
            className="shell wb-shell"
            data-sidebar={collapsed && !narrow && !minimal ? 'min' : 'full'}
            data-panel={panel.open ? 'open' : 'closed'}
            data-narrow={narrow ? '' : undefined}
            data-minimal={minimal ? '' : undefined}
            data-working={minimal && panel.open && !narrow ? '' : undefined}
        >
            <div className="wb-glow" aria-hidden="true" />
            {drawer ? <div className="wb-backdrop" aria-hidden="true" onClick={() => closeDrawer(true)} /> : null}
            <aside
                id="wb-side"
                ref={sideRef}
                className="wb-side"
                aria-label={t('wb.sidebar')}
                data-open={drawer ? '' : undefined}
                // 点了抽屉里的链接或面板按钮就收起(指向当前页的链接不会换页,这里补上)
                onClick={(e) => {
                    if (drawer && (e.target as HTMLElement).closest('a, .wb-side-item')) closeDrawer(false);
                }}
            >
                <div className="wb-side-head">
                    <Link to={{ name: 'home' }} className="wb-brand" label="FatCat-AI">
                        <Icon name="paw" size={24} />
                        <span className="wb-side-text">FatCat-AI</span>
                    </Link>
                    <button
                        type="button"
                        className="wb-side-toggle"
                        aria-expanded={!collapsed}
                        aria-label={collapsed ? t('wb.sidebar.expand') : t('wb.sidebar.collapse')}
                        title={`${collapsed ? t('wb.sidebar.expand') : t('wb.sidebar.collapse')} (Ctrl B)`}
                        onClick={toggleSidebar}
                    >
                        <Icon name={collapsed ? 'fwd' : 'back'} size={16} />
                    </button>
                </div>
                <Link to={{ name: 'home' }} className="wb-side-item wb-new" label={t('nav.newChat')}>
                    <Icon name="chat" size={20} />
                    <span className="wb-side-text">{t('nav.newChat')}</span>
                </Link>
                <nav className="wb-side-group" aria-label={t('wb.railLabel')}>
                    {/* 记忆面板仍可由 ui.panel 或命令打开 */}
                    {sidePanels.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            className={`wb-side-item${panel.open && panel.panel === item.id ? ' on' : ''}`}
                            aria-label={t(item.label)}
                            aria-pressed={panel.open && panel.panel === item.id}
                            title={t(item.label)}
                            onClick={() => dispatch({ type: 'pin', panel: item.id })}
                        >
                            <Icon name={item.icon} size={20} />
                            <span className="wb-side-text">{t(item.label)}</span>
                        </button>
                    ))}
                </nav>
                {sessions.length > 0 ? (
                    <ul className="wb-sessions" aria-label={t('wb.sessions')}>
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
                ) : (
                    <span className="wb-side-fill" />
                )}
                <nav className="wb-side-group wb-side-foot" aria-label={t('wb.pages')}>
                    {pageLinks.map((item) => (
                        <Link
                            key={item.label}
                            to={item.to}
                            className="wb-side-item"
                            label={t(item.label)}
                            current={
                                route.name === item.to.name ||
                                (item.to.name === 'knowledge' && (route.name === 'items' || route.name === 'memory'))
                            }
                        >
                            <Icon name={item.icon} size={20} />
                            <span className="wb-side-text">{t(item.label)}</span>
                        </Link>
                    ))}
                    <button
                        type="button"
                        className="wb-side-item"
                        aria-label={t('auth.logout')}
                        title={t('auth.logout')}
                        onClick={() => void onLogout()}
                    >
                        <Icon name="lock" size={20} />
                        <span className="wb-side-text">{t('auth.logout')}</span>
                    </button>
                    {narrow && canInstall ? (
                        <button type="button" className="wb-side-item" onClick={() => void install()}>
                            <Icon name="paw" size={20} />
                            <span className="wb-side-text">{t('pwa.install')}</span>
                        </button>
                    ) : null}
                </nav>
                {/* 极简主界面隐藏页脚:许可证与源码链接放进抽屉(AGPL 第 13 条要能找到源码) */}
                {narrow || minimal ? <Footer meta={meta} /> : null}
            </aside>
            <div className="wb-world">
                {minimal ? (
                    <button
                        type="button"
                        ref={menuRef}
                        className="wb-logo"
                        aria-label={t('nav.menu')}
                        title={t('nav.menu')}
                        aria-expanded={drawer}
                        aria-controls="wb-side"
                        onClick={() => setDrawerAt(drawer ? null : routeKey)}
                        data-testid="wb-logo"
                    >
                        <Icon name="paw" size={20} />
                    </button>
                ) : null}
                <div className="wb-capsule" hidden={minimal}>
                    {narrow ? (
                        <button
                            type="button"
                            ref={minimal ? undefined : menuRef}
                            className="wb-capsule-btn wb-menu"
                            aria-label={t('nav.menu')}
                            aria-expanded={drawer}
                            aria-controls="wb-side"
                            onClick={() => setDrawerAt(drawer ? null : routeKey)}
                        >
                            <Icon name="menu" size={20} />
                        </button>
                    ) : null}
                    <span className="wb-capsule-title" title={sessionTitle}>
                        {sessionTitle}
                        {serverVersion ? <small> v{serverVersion}</small> : null}
                    </span>
                    <button
                        type="button"
                        className="wb-capsule-btn"
                        aria-label={t('wb.searchPlaceholder')}
                        title={`${t('wb.searchPlaceholder')} (${t('wb.kbd')})`}
                        onClick={() => setSearchOpen(true)}
                    >
                        <Icon name="search" size={16} />
                    </button>
                    <div className="wb-model">
                        <button
                            type="button"
                            className="wb-pill"
                            aria-haspopup="listbox"
                            aria-expanded={modelOpen}
                            onClick={() => setModelOpen((open) => !open)}
                        >
                            <Icon name="cat" size={16} />
                            {agentName ? `${modelLabel} · ${agentName}` : modelLabel}
                        </button>
                        {modelOpen ? (
                            <ul className="wb-model-menu" role="listbox">
                                {/* 模型与代理各是一个 group,标题不是可选项(读屏不会把它当成选项) */}
                                <li role="group" aria-label={t('models.model')}>
                                    <ul>
                                        {chatProfiles.length === 0 ? (
                                            <li role="presentation" className="muted">
                                                {t('wb.noModel')}
                                            </li>
                                        ) : null}
                                        {chatProfiles.map((profile) => (
                                            <li key={profile.id} role="presentation">
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
                                </li>
                                {narrow && agentChoices.length > 1 ? (
                                    <li role="group" aria-label={t('agents.picker')}>
                                        <span className="wb-search-label" aria-hidden="true">
                                            {t('agents.picker')}
                                        </span>
                                        <ul>
                                            {agentChoices.map((agent) => (
                                                <li key={`agent-${agent.id}`} role="presentation">
                                                    <button
                                                        type="button"
                                                        role="option"
                                                        aria-selected={agent.id === (activity?.agentId ?? '')}
                                                        onClick={() => {
                                                            setModelOpen(false);
                                                            activity?.chooseAgent(agent.id);
                                                        }}
                                                    >
                                                        {agent.name}
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    </li>
                                ) : null}
                            </ul>
                        ) : null}
                    </div>
                </div>
                {searchOpen ? (
                    <div className="wb-palette">
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
                                    {shownFiles.length > 0 ? (
                                        <li className="wb-search-label">{t('wb.searchFiles')}</li>
                                    ) : null}
                                    {hits.map((hit, index) => (
                                        <li
                                            key={
                                                hit.kind === 'file'
                                                    ? hit.item.id
                                                    : hit.kind === 'command'
                                                      ? hit.id
                                                      : 'ask'
                                            }
                                        >
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
                    </div>
                ) : null}
                <ApprovalPanel currentSessionId={sessionId} onCount={onApprovals} />
                {pending ? (
                    <div className="card wb-confirm" role="dialog">
                        <p>{pending.kind === 'all' ? t('nav.clearSessionsConfirm') : t('chat.deleteConfirm')}</p>
                        <div className="row">
                            <button
                                type="button"
                                className="danger"
                                disabled={busy}
                                onClick={() => void confirmPending()}
                            >
                                {t('nav.confirm')}
                            </button>
                            <button type="button" onClick={() => setPending(null)}>
                                {t('nav.cancel')}
                            </button>
                        </div>
                    </div>
                ) : null}
                {pageView ? (
                    <main className="wb-page">{pageView}</main>
                ) : (
                    <section className="wb-stage">
                        {minimal && running.rows.length > 0 ? (
                            // 工作态:球和面板之间竖排本轮工具的小胶囊,完成后淡出(ADR 0049 第 10.5 节)
                            <ol className="wb-pills" aria-label={t('wb.running')} data-testid="wb-pills">
                                {running.rows.map((row) => {
                                    const icon = statusIcon(row.status);
                                    return (
                                        <li
                                            key={row.callId}
                                            className="wb-pill-tool"
                                            data-status={row.status}
                                            title={row.summary}
                                        >
                                            {icon ? (
                                                <Icon name={icon} size={16} />
                                            ) : (
                                                <span className="wb-spin" aria-hidden="true" />
                                            )}
                                            <span>{row.name}</span>
                                        </li>
                                    );
                                })}
                            </ol>
                        ) : null}
                        {!minimal && running.rows.length > 0 ? (
                            <div className="wb-glass wb-running" aria-live="polite">
                                <h4>{t('wb.running')}</h4>
                                {running.hidden > 0 ? (
                                    <p className="wb-more-count">{t('wb.runningMore', { n: running.hidden })}</p>
                                ) : null}
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
                        ) : null}
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
                )}
                {minimal && activeRow ? (
                    // 右上角临时显示正在执行的工具名(ADR 0049 第 10.5 节)
                    <div className="wb-now wb-glass" role="status" data-testid="wb-now">
                        <span className="wb-spin" aria-hidden="true" />
                        <span>{activeRow.name}</span>
                    </div>
                ) : null}
                {panel.open ? (
                    <aside className="wb-float wb-glass" aria-label={panelTitle(panel.panel)}>
                        <header className="wb-float-head">
                            <h3>{panelTitle(panel.panel)}</h3>
                            <button
                                type="button"
                                className="wb-float-close"
                                aria-label={t('wb.closePanel')}
                                title={`${t('wb.closePanel')} (Esc)`}
                                onClick={() => dispatch({ type: 'close' })}
                            >
                                <Icon name="x" size={16} />
                            </button>
                        </header>
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
                            {panel.panel === 'mail' ? <MailPage key={panel.opened} /> : null}
                            {panel.panel === 'code' ? <CodePanel view={code} /> : null}
                            {panel.panel === 'memory' ? (
                                <MemoryPage key={panel.opened} settings={settings} onSettings={onSettings} />
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
                    </aside>
                ) : null}
            </div>
            {narrow && !minimal ? (
                <nav className="wb-tabs" aria-label={t('wb.tabs')}>
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            className="wb-tab"
                            aria-current={tab.on ? 'page' : undefined}
                            onClick={() => runTab(tab.id)}
                        >
                            <Icon name={tab.icon} size={20} />
                            <span>{tab.label}</span>
                        </button>
                    ))}
                </nav>
            ) : null}
        </div>
    );
}
