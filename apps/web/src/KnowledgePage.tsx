// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 「知识」入口(M12 knowledge-hero):合并原来的知识地图和记忆。主视觉切到知识模式:第一层是记忆三类和知识顶层分类,
// 点一个展开成带名字的子项,点子项浮出一句原文的气泡,点气泡打开全文卡片(来源、编辑、删除、置顶)。
// 左上胶囊是面包屑和搜索;Esc 返回上一层;「列表」视图保留原来的批量管理页面。数据和接口不变。
import type { Item, Memory, MemorySource, Settings } from '@fatcat-ai/shared';
import {
    expandedId,
    firstSentence,
    hitPath,
    type Hero,
    type KnowledgeNode,
    type KnowledgeScene,
    MAX_VISIBLE_NODES,
} from '@fatcat-ai/ui';
import { resolveTheme } from '@fatcat-ai/ui/theme-ids';
import {
    type FormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { api, errorText } from './api.js';
import { Segmented } from './controls.js';
import { useI18n } from './i18n.js';
import { itemTitle } from './item-title.js';
import { ItemsPage } from './ItemsPage.js';
import {
    conflictIds,
    itemNodes,
    loadPinned,
    MEM_TYPES,
    memoryNodes,
    parseNodeId,
    savePinned,
    typeId,
} from './knowledge-data.js';
import { MemoryPage } from './MemoryPage.js';

type Crumb = { id: string; label: string };

const NO_HITS: ReadonlySet<string> = new Set();

interface Detail {
    id: string;
    title: string;
    text: string;
    source: string | null;
    memory: Memory | null;
}

export function KnowledgePage({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
    const { t } = useI18n();
    const title = useCallback((i: Item) => itemTitle(i, t), [t]);
    const [view, setView] = useState<'map' | 'list'>('map');
    const [listTab, setListTab] = useState<'memory' | 'items'>('memory');
    const [memories, setMemories] = useState<Memory[]>([]);
    const [conflicts, setConflicts] = useState<Set<string>>(new Set());
    const [itemRoots, setItemRoots] = useState<Item[]>([]);
    const [pinned, setPinned] = useState<Set<string>>(loadPinned);
    const [path, setPath] = useState<Crumb[]>([]);
    const [children, setChildren] = useState<KnowledgeNode[]>([]);
    // 「加载更多」显示到第几个;换层后回到一屏上限
    const [more, setMore] = useState<{ open: string | null; n: number }>({ open: null, n: MAX_VISIBLE_NODES });
    const [cursor, setCursor] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [focus, setFocus] = useState<string | null>(null);
    const [hover, setHover] = useState<string | null>(null);
    const [bubbleSize, setBubbleSize] = useState<{ w: number; h: number } | null>(null);
    const [bubble, setBubble] = useState<string | null>(null);
    const [detail, setDetail] = useState<Detail | null>(null);
    const [query, setQuery] = useState('');
    const [hits, setHits] = useState<ReadonlySet<string>>(NO_HITS);
    const activeHits = query.trim() ? hits : NO_HITS;
    const [error, setError] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const canvas = useRef<HTMLCanvasElement>(null);
    const hero = useRef<Hero | null>(null);
    const bubbleRef = useRef<HTMLButtonElement>(null);

    const loadAll = useCallback(async () => {
        try {
            const [mem, conf, roots] = await Promise.all([
                api.memory.list({ limit: 200 }),
                api.memory.conflicts().catch(() => ({ items: [] })),
                api.items.roots(),
            ]);
            setMemories(mem.items);
            setConflicts(conflictIds(conf.items));
            setItemRoots(roots.items);
            setError(null);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setLoaded(true);
        }
    }, []);
    useEffect(() => {
        const timer = window.setTimeout(() => void loadAll(), 0);
        return () => window.clearTimeout(timer);
    }, [loadAll]);

    const roots = useMemo<KnowledgeNode[]>(
        () => [
            ...MEM_TYPES.map((m) => ({
                id: typeId(m),
                label: t(`knowledge.type.${m}`),
                kind: 'branch' as const,
            })),
            // 条目索引里也有一个「记忆」根:记忆已经按三类放在第一层,这里不重复;第一层都可以展开
            ...itemNodes(
                itemRoots.filter((i) => i.type !== 'memory'),
                pinned,
                title,
            ).map((n) => ({ ...n, kind: 'branch' as const })),
        ],
        [itemRoots, pinned, t, title],
    );

    // 打开一层:读取它的子项(条目分页取,记忆在本地按类别过滤)
    const loadChildren = useCallback(
        async (id: string, after: string | null = null) => {
            const ref = parseNodeId(id);
            if (!ref) return;
            try {
                if (ref.kind === 'type') {
                    setChildren(memoryNodes(memories, ref.memType, conflicts, pinned));
                    setCursor(null);
                } else if (ref.kind === 'item') {
                    const page = await api.items.children(ref.id, {
                        limit: MAX_VISIBLE_NODES,
                        ...(after ? { cursor: after } : {}),
                    });
                    const nodes = itemNodes(page.items, pinned, title);
                    setChildren((prev) => (after ? [...prev, ...nodes] : nodes));
                    setCursor(page.nextCursor ?? null);
                }
                setError(null);
            } catch (e) {
                setError(errorText(e));
            }
        },
        [conflicts, memories, pinned, title],
    );

    const open = expandedId({ path });
    useEffect(() => {
        if (!open) return;
        const timer = window.setTimeout(() => void loadChildren(open), 0);
        return () => window.clearTimeout(timer);
        // 只在换层或数据刷新时重新读取
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, memories, conflicts]);
    const shown = more.open === open ? more.n : MAX_VISIBLE_NODES;
    const levelChildren = open ? children : [];

    const visible = levelChildren.slice(0, shown);
    const moreCount = open ? Math.max(0, levelChildren.length - shown) + (cursor ? 1 : 0) : 0;
    const scene: KnowledgeScene = useMemo(
        () => ({
            roots,
            path,
            children: visible,
            selectedId: selected,
            focusId: focus,
            hits: activeHits,
            hoverId: hover,
            bubble: bubbleSize,
        }),
        // visible 由 children / shown 决定
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [roots, path, levelChildren, shown, selected, focus, activeHits, hover, bubbleSize],
    );

    // 主视觉:当前主题的知识模式;canvas 不可用时只显示列表
    const [noCanvas, setNoCanvas] = useState(false);
    useEffect(() => {
        if (view !== 'map') return;
        let cancelled = false;
        void import('@fatcat-ai/ui')
            .then(({ createHero }) => {
                if (cancelled || !canvas.current) return;
                hero.current = createHero(resolveTheme(document.documentElement.dataset.theme), canvas.current);
                if (!hero.current) {
                    setNoCanvas(true);
                    return;
                }
                hero.current.setMode('knowledge');
                hero.current.setState('idle');
            })
            .catch(() => setNoCanvas(true));
        return () => {
            cancelled = true;
            hero.current?.destroy();
            hero.current = null;
        };
    }, [view, settings.theme]);
    useEffect(() => {
        hero.current?.setScene(scene);
    }, [scene, noCanvas, view]);

    // 气泡跟着节点走(节点会缓慢漂移)
    useEffect(() => {
        if (!bubble) return;
        let raf = 0;
        const follow = () => {
            const at = hero.current?.locate(bubble);
            const el = bubbleRef.current;
            if (el && at) {
                el.style.left = `${at.x}px`;
                el.style.top = `${at.y}px`;
            }
            raf = requestAnimationFrame(follow);
        };
        follow();
        return () => cancelAnimationFrame(raf);
    }, [bubble]);

    const [bubbleText, setBubbleText] = useState('');
    // 量出气泡的实际大小,主视觉据此让开其他节点的标签
    useEffect(() => {
        const el = bubbleRef.current;
        if (!bubble || !el) return setBubbleSize(null);
        setBubbleSize((old) =>
            old && old.w === el.offsetWidth && old.h === el.offsetHeight
                ? old
                : { w: el.offsetWidth, h: el.offsetHeight },
        );
    }, [bubble, bubbleText]);
    const showBubble = async (node: KnowledgeNode) => {
        setSelected(node.id);
        setBubble(node.id);
        const ref = parseNodeId(node.id);
        if (ref?.kind === 'memory') {
            setBubbleText(firstSentence(memories.find((m) => m.id === ref.id)?.text ?? node.label));
        } else if (ref?.kind === 'item') {
            setBubbleText(node.label);
            try {
                const content = await api.items.content(ref.id);
                setBubbleText(firstSentence(content.content) || node.label);
            } catch {
                // 没有正文的条目只显示标题
            }
        }
    };

    const openDetail = async (id: string) => {
        const ref = parseNodeId(id);
        if (ref?.kind === 'memory') {
            const memory = memories.find((m) => m.id === ref.id);
            if (!memory) return;
            setDetail({ id, title: t(`knowledge.type.${memory.memType}`), text: memory.text, source: null, memory });
            try {
                const sources: MemorySource[] = (await api.memory.sources(memory.id)).items;
                const first = sources[0];
                setDetail((d) =>
                    d && d.id === id
                        ? { ...d, source: first ? (first.excerpt ?? first.sessionId ?? first.itemId ?? null) : null }
                        : d,
                );
            } catch {
                // 来源读不到不影响查看正文
            }
        } else if (ref?.kind === 'item') {
            try {
                const [item, content] = await Promise.all([api.items.get(ref.id), api.items.content(ref.id)]);
                setDetail({
                    id,
                    title: title(item),
                    text: content.content,
                    source: item.sourceRef ?? item.source,
                    memory: null,
                });
            } catch (e) {
                setError(errorText(e));
            }
        }
    };

    const activate = (id: string | null) => {
        if (!id) return;
        if (id === open) return;
        const node = (path.length === 0 ? roots : visible).find((n) => n.id === id);
        if (!node) return;
        if (node.kind === 'branch') {
            setPath((p) => [...p, { id: node.id, label: node.label }]);
            setSelected(null);
            setBubble(null);
            setFocus(null);
        } else if (selected === node.id && bubble) {
            void openDetail(node.id);
        } else void showBubble(node);
    };

    const back = useCallback(() => {
        if (detail) setDetail(null);
        else if (bubble) {
            setBubble(null);
            setSelected(null);
        } else if (path.length > 0) {
            setPath((p) => p.slice(0, -1));
            setFocus(null);
        }
    }, [bubble, detail, path.length]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || view !== 'map' || e.defaultPrevented) return;
            if (!detail && !bubble && path.length === 0) return;
            e.preventDefault();
            back();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [back, bubble, detail, path.length, view]);

    // 搜索:命中的条目连同祖先、命中的记忆连同它的类别一起点亮
    useEffect(() => {
        const q = query.trim();
        if (!q) return;
        let alive = true;
        const timer = window.setTimeout(() => {
            void (async () => {
                const [items, mems] = await Promise.all([
                    api.items.search({ q, limit: 30 }).catch(() => ({ items: [] as Item[] })),
                    api.memory.search({ query: q, limit: 30 }).catch(() => ({ items: [] as Memory[] })),
                ]);
                const itemHits = await Promise.all(
                    items.items.slice(0, 20).map(async (i) => ({
                        id: `i:${i.id}`,
                        ancestors: (await api.items.ancestors(i.id).catch(() => ({ items: [] as Item[] }))).items.map(
                            (a) => `i:${a.id}`,
                        ),
                    })),
                );
                const memHits = mems.items.map((m) => ({ id: `m:${m.id}`, ancestors: [typeId(m.memType)] }));
                if (alive) setHits(hitPath([...itemHits, ...memHits]));
            })();
        }, 250);
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [query]);

    const togglePin = (id: string) => {
        setPinned((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            savePinned(next);
            return next;
        });
    };

    const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const id = hero.current?.pick(e.clientX - rect.left, e.clientY - rect.top) ?? null;
        if (id) activate(id);
        else if (bubble) {
            setBubble(null);
            setSelected(null);
        }
    };

    const keyNodes = path.length === 0 ? roots : visible;
    const onNodesKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const i = keyNodes.findIndex((n) => n.id === focus);
        const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
        const next = keyNodes[(i + step + keyNodes.length) % keyNodes.length];
        if (next) document.getElementById(`kn-${next.id}`)?.focus();
    };

    const empty = loaded && memories.length === 0 && itemRoots.length === 0;

    return (
        <div className="kn-page" data-testid="knowledge">
            <h1 className="visually-hidden">{t('nav.knowledge')}</h1>
            <div className="kn-capsule">
                <nav className="kn-crumbs" aria-label={t('knowledge.breadcrumb')}>
                    <button type="button" onClick={() => (setPath([]), setBubble(null), setSelected(null))}>
                        {t('nav.knowledge')}
                    </button>
                    {path.map((c, i) => (
                        <span key={c.id}>
                            <span aria-hidden="true">›</span>
                            <button
                                type="button"
                                aria-current={i === path.length - 1 ? 'location' : undefined}
                                onClick={() => (setPath(path.slice(0, i + 1)), setBubble(null), setSelected(null))}
                            >
                                {c.label}
                            </button>
                        </span>
                    ))}
                </nav>
                <input
                    type="search"
                    className="kn-search"
                    value={query}
                    placeholder={t('knowledge.search')}
                    aria-label={t('knowledge.search')}
                    onChange={(e) => setQuery(e.target.value)}
                />
            </div>
            <div className="kn-view">
                <Segmented
                    label={t('knowledge.view')}
                    value={view}
                    options={[
                        { value: 'map', label: t('knowledge.view.map') },
                        { value: 'list', label: t('knowledge.view.list') },
                    ]}
                    onChange={setView}
                />
            </div>
            {view === 'list' || noCanvas ? (
                <div className="kn-list">
                    <Segmented
                        label={t('knowledge.view.list')}
                        value={listTab}
                        options={[
                            { value: 'memory', label: t('nav.memory') },
                            { value: 'items', label: t('knowledge.items') },
                        ]}
                        onChange={setListTab}
                    />
                    {listTab === 'memory' ? <MemoryPage settings={settings} onSettings={onSettings} /> : <ItemsPage />}
                </div>
            ) : (
                <div className="kn-stage">
                    <canvas
                        ref={canvas}
                        className="kn-canvas"
                        aria-hidden="true"
                        onClick={onCanvasClick}
                        onMouseMove={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const id = hero.current?.pick(e.clientX - rect.left, e.clientY - rect.top) ?? null;
                            e.currentTarget.style.cursor = id ? 'pointer' : 'default';
                            setHover(id);
                        }}
                        onMouseLeave={() => setHover(null)}
                    />
                    {/* 键盘操作:每个节点一个按钮(视觉上隐藏),方向键移动,回车打开 */}
                    <ul className="kn-nodes visually-hidden" aria-label={t('knowledge.nodes')} onKeyDown={onNodesKey}>
                        {keyNodes.map((n) => (
                            <li key={n.id}>
                                <button
                                    type="button"
                                    id={`kn-${n.id}`}
                                    onFocus={() => setFocus(n.id)}
                                    onBlur={() => setFocus((f) => (f === n.id ? null : f))}
                                    onClick={() => activate(n.id)}
                                >
                                    {n.label}
                                    {n.conflict ? ` (${t('knowledge.conflict')})` : ''}
                                    {activeHits.has(n.id) ? ` (${t('knowledge.hit')})` : ''}
                                </button>
                            </li>
                        ))}
                    </ul>
                    {bubble ? (
                        <button
                            type="button"
                            ref={bubbleRef}
                            className="kn-bubble"
                            data-testid="knowledge-bubble"
                            onClick={() => void openDetail(bubble)}
                        >
                            {bubbleText}
                        </button>
                    ) : null}
                    {moreCount > 0 ? (
                        <button
                            type="button"
                            className="kn-more"
                            onClick={() => {
                                if (levelChildren.length > shown) setMore({ open, n: shown + MAX_VISIBLE_NODES });
                                else if (open && cursor) void loadChildren(open, cursor);
                            }}
                        >
                            {t('knowledge.more')}
                        </button>
                    ) : null}
                    {empty ? <p className="kn-empty muted">{t('knowledge.empty')}</p> : null}
                    {open && loaded && levelChildren.length === 0 ? (
                        <p className="kn-empty muted">{t('knowledge.emptyLevel')}</p>
                    ) : null}
                </div>
            )}
            {error ? (
                <p className="error kn-error" role="alert">
                    {error}
                </p>
            ) : null}
            {detail ? (
                <DetailCard
                    detail={detail}
                    pinned={pinned.has(detail.id)}
                    onPin={() => togglePin(detail.id)}
                    onClose={() => setDetail(null)}
                    onChanged={async () => {
                        setDetail(null);
                        setBubble(null);
                        setSelected(null);
                        await loadAll();
                    }}
                />
            ) : null}
        </div>
    );
}

function DetailCard({
    detail,
    pinned,
    onPin,
    onClose,
    onChanged,
}: {
    detail: Detail;
    pinned: boolean;
    onPin: () => void;
    onClose: () => void;
    onChanged: () => Promise<void>;
}) {
    const { t } = useI18n();
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(detail.text);
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const memory = detail.memory;
    const closeRef = useRef<HTMLButtonElement>(null);
    useEffect(() => closeRef.current?.focus(), []);

    const save = async (e: FormEvent) => {
        e.preventDefault();
        if (!memory) return;
        try {
            await api.memory.update(memory.id, { text });
            await onChanged();
        } catch (err) {
            setError(errorText(err));
        }
    };
    const remove = async () => {
        if (!memory) return;
        try {
            await api.memory.delete(memory.id);
            await onChanged();
        } catch (err) {
            setError(errorText(err));
        }
    };

    return (
        <aside className="kn-card wb-glass" role="dialog" aria-label={detail.title} data-testid="knowledge-card">
            <header className="kn-card-head">
                <h3>{detail.title}</h3>
                <button
                    type="button"
                    ref={closeRef}
                    className="wb-float-close"
                    aria-label={t('knowledge.close')}
                    onClick={onClose}
                >
                    ×
                </button>
            </header>
            {editing && memory ? (
                <form className="form" onSubmit={save}>
                    <textarea
                        value={text}
                        rows={5}
                        aria-label={t('memory.edit')}
                        onChange={(e) => setText(e.target.value)}
                    />
                    <div className="row">
                        <button type="submit" className="primary">
                            {t('memory.save')}
                        </button>
                        <button type="button" onClick={() => setEditing(false)}>
                            {t('nav.cancel')}
                        </button>
                    </div>
                </form>
            ) : (
                <div className="kn-card-text">{detail.text.slice(0, 8000)}</div>
            )}
            {detail.source ? (
                <p className="small muted">
                    {t('knowledge.source')}: {detail.source}
                </p>
            ) : null}
            {error ? <p className="error small">{error}</p> : null}
            <div className="row">
                <button type="button" aria-pressed={pinned} onClick={onPin}>
                    {pinned ? t('knowledge.unpin') : t('knowledge.pin')}
                </button>
                {memory && !editing ? (
                    <button type="button" onClick={() => setEditing(true)}>
                        {t('memory.edit')}
                    </button>
                ) : null}
                {memory ? (
                    confirming ? (
                        <>
                            <button type="button" className="danger" onClick={() => void remove()}>
                                {t('knowledge.deleteConfirm')}
                            </button>
                            <button type="button" onClick={() => setConfirming(false)}>
                                {t('nav.cancel')}
                            </button>
                        </>
                    ) : (
                        <button type="button" className="danger" onClick={() => setConfirming(true)}>
                            {t('memory.delete')}
                        </button>
                    )
                ) : null}
            </div>
        </aside>
    );
}
