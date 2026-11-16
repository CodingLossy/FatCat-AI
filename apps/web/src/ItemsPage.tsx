// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Item, ItemContent, ItemRelatedEntry, ItemSort } from '@fatcat-ai/shared';
import { breadcrumbOf, type Crumb, mergePage, toggleExpanded, virtualWindow } from '@fatcat-ai/ui';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { navigate } from './router.js';

/** 列表行高(像素,固定;虚拟滚动只渲染视口附近的行)。触摸目标不小于 44px。 */
export const ROW_HEIGHT = 44;
const DEFAULT_VIEW_HEIGHT = 440;
const PAGE = 50;

interface Kids {
    items: Item[];
    cursor: string | null;
}

/** 能下钻的条目:分类,或有子项。 */
const isBranch = (i: Item) => i.kind === 'category' || i.childCount > 0;

/** 「问 AI」:新建会话,把预填提示词放进输入框(不自动发送;条目文字被包成不可信数据)。 */
async function askAbout(item: Item, scope: 'item' | 'subtree'): Promise<void> {
    const { sessionId, prompt } = await api.items.ask(item.id, { scope });
    try {
        sessionStorage.setItem(`fatcat.prefill.${sessionId}`, prompt);
    } catch {
        // 不能写 sessionStorage 时只是没有预填
    }
    navigate({ name: 'session', id: sessionId });
}

function Count({ item }: { item: Item }) {
    return isBranch(item) ? <span className="small muted"> ({item.contentCount ?? item.childCount})</span> : null;
}

/** 左侧的树:只列能下钻的条目,展开时才请求 children。 */
function TreeBranch(props: {
    items: Item[];
    kids: Record<string, Kids>;
    expanded: ReadonlySet<string>;
    currentId: string | null;
    onToggle: (item: Item) => void;
    onGo: (item: Item) => void;
    onMore: (id: string) => void;
}) {
    const { t } = useI18n();
    return (
        <ul className="tree">
            {props.items.filter(isBranch).map((item) => {
                const open = props.expanded.has(item.id);
                const sub = props.kids[item.id];
                return (
                    <li key={item.id} className="tree-node" data-item-type={item.type}>
                        <div className={`tree-row${props.currentId === item.id ? ' active' : ''}`}>
                            <button
                                type="button"
                                className="link tree-twist"
                                aria-expanded={open}
                                aria-label={open ? t('items.collapse') : t('items.expand')}
                                onClick={() => props.onToggle(item)}
                            >
                                {open ? '▾' : '▸'}
                            </button>
                            <button type="button" className="link tree-toggle" onClick={() => props.onGo(item)}>
                                {item.title}
                            </button>
                            <Count item={item} />
                        </div>
                        {open && sub ? (
                            <>
                                <TreeBranch {...props} items={sub.items} />
                                {sub.cursor ? (
                                    <button type="button" className="link small" onClick={() => props.onMore(item.id)}>
                                        {t('items.more')}
                                    </button>
                                ) : null}
                            </>
                        ) : null}
                    </li>
                );
            })}
        </ul>
    );
}

/** 右侧的列表:固定行高的虚拟窗口。 */
function VirtualList(props: { items: Item[]; onPick: (item: Item) => void; onNearEnd: () => void }) {
    const { t } = useI18n();
    const box = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewport, setViewport] = useState(DEFAULT_VIEW_HEIGHT);
    const measure = useCallback(() => {
        const el = box.current;
        if (!el) return;
        setScrollTop(el.scrollTop);
        if (el.clientHeight > 0) setViewport(el.clientHeight);
    }, []);
    useEffect(() => {
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [measure]);
    const { items, onNearEnd } = props;
    const win = virtualWindow({ count: items.length, rowHeight: ROW_HEIGHT, viewportHeight: viewport, scrollTop });
    useEffect(() => {
        if (items.length > 0 && win.end >= items.length - 5) onNearEnd();
    }, [win.end, items.length, onNearEnd]);
    return (
        <div className="item-list" ref={box} onScroll={measure} role="list" aria-label={t('items.list')}>
            <div style={{ height: win.totalHeight, position: 'relative' }}>
                <div style={{ position: 'absolute', top: win.offsetTop, left: 0, right: 0 }}>
                    {items.slice(win.start, win.end).map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            role="listitem"
                            className="item-row"
                            style={{ height: ROW_HEIGHT }}
                            data-item-type={item.type}
                            onClick={() => props.onPick(item)}
                        >
                            <span className="item-row-title">
                                {isBranch(item) ? '▸ ' : ''}
                                {item.title}
                            </span>
                            <span className="small muted item-row-meta">
                                {item.type} · {item.updatedAt.slice(0, 10)}
                                {isBranch(item) ? ` · ${item.contentCount ?? item.childCount}` : ''}
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

/** 知识地图的分类浏览器(v1.0,纯 REST):树 + 列表 + 面包屑 + 详情,手机上树收进抽屉。 */
export function ItemsPage() {
    const { t } = useI18n();
    const [roots, setRoots] = useState<Item[] | null>(null);
    const [kids, setKids] = useState<Record<string, Kids>>({});
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const [current, setCurrent] = useState<Item | null>(null);
    const [trail, setTrail] = useState<Crumb[]>([]);
    const [list, setList] = useState<Kids>({ items: [], cursor: null });
    const [listLoading, setListLoading] = useState(false);
    const [sort, setSort] = useState<ItemSort>('position');
    const [type, setType] = useState('');
    const [types, setTypes] = useState<string[]>([]);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<Item[] | null>(null);
    const [detail, setDetail] = useState<Item | null>(null);
    const [content, setContent] = useState<ItemContent | null>(null);
    const [related, setRelated] = useState<ItemRelatedEntry[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [drawer, setDrawer] = useState(false);
    const listKey = useRef(0);

    const fail = (e: unknown) => setError(errorText(e));

    const loadRoots = useCallback(() => {
        api.items
            .roots()
            .then((page) => setRoots(page.items))
            .catch(fail);
    }, []);
    useEffect(loadRoots, [loadRoots]);

    const loadKids = useCallback(async (id: string, cursor?: string) => {
        const page = await api.items.children(id, { limit: PAGE, ...(cursor ? { cursor } : {}) });
        setKids((old) => ({
            ...old,
            [id]: { items: mergePage(cursor ? (old[id]?.items ?? []) : [], page.items), cursor: page.nextCursor },
        }));
    }, []);

    /** 列表(右侧):当前分类的子项,支持类型 / 排序;换分类或条件时丢弃过期响应。 */
    const loadList = useCallback(async (id: string, sortBy: ItemSort, typeBy: string, cursor?: string) => {
        const key = ++listKey.current;
        setListLoading(true);
        try {
            const page = await api.items.children(id, {
                limit: PAGE,
                sort: sortBy,
                ...(typeBy ? { type: typeBy } : {}),
                ...(cursor ? { cursor } : {}),
            });
            if (key !== listKey.current) return;
            setList((old) => ({
                items: mergePage(cursor ? old.items : [], page.items),
                cursor: page.nextCursor,
            }));
        } catch (e) {
            if (key === listKey.current) fail(e);
        } finally {
            if (key === listKey.current) setListLoading(false);
        }
    }, []);

    /** 进入一个分类:面包屑、树展开到它、列表换成它的子项。 */
    const go = useCallback(
        async (item: Item) => {
            setError(null);
            setResults(null);
            setDetail(null);
            setContent(null);
            setCurrent(item);
            setSort('position');
            setType('');
            setDrawer(false);
            try {
                const [ancestors, counts] = await Promise.all([
                    api.items.ancestors(item.id),
                    api.items.counts(item.id),
                ]);
                setTrail(breadcrumbOf(ancestors.items, item));
                setTypes(Object.keys(counts.byType).sort());
                const path = [...ancestors.items.map((a) => a.id), item.id];
                setExpanded((old) => new Set([...old, ...path]));
                await Promise.all(path.filter((id) => !kids[id]).map((id) => loadKids(id)));
            } catch (e) {
                fail(e);
            }
            void loadList(item.id, 'position', '');
        },
        [kids, loadKids, loadList],
    );

    const toggle = (item: Item) => {
        const open = expanded.has(item.id);
        setExpanded(toggleExpanded(expanded, item.id));
        if (!open && !kids[item.id]) void loadKids(item.id).catch(fail);
    };

    /** 打开一个条目:有子项就下钻,否则显示详情(正文与「也出现在…」)。 */
    const pick = async (item: Item) => {
        if (isBranch(item)) return void go(item);
        setDetail(item);
        setContent(null);
        setRelated([]);
        setDetailError(null);
        setError(null);
        // 正文、位置与「也出现在…」各自加载:正文打不开(例如二进制文件)时,其余仍然可用
        void api.items
            .content(item.id)
            .then(setContent)
            .catch((e: unknown) => setDetailError(errorText(e)));
        void api.items
            .related(item.id, { limit: 20 })
            .then((rel) => setRelated(rel.items))
            .catch(() => undefined);
        try {
            const ancestors = await api.items.ancestors(item.id);
            setTrail(breadcrumbOf(ancestors.items, item));
        } catch (e) {
            fail(e);
        }
    };

    const search = async () => {
        const q = query.trim();
        if (!q) return setResults(null);
        try {
            const page = await api.items.search({ q, ...(current ? { under: current.id } : {}), limit: 50 });
            setResults(page.items);
        } catch (e) {
            fail(e);
        }
    };

    const ask = (item: Item, scope: 'item' | 'subtree') => void askAbout(item, scope).catch(fail);

    const sync = async () => {
        try {
            await api.items.sync();
            setRoots(null);
            setKids({});
            loadRoots();
        } catch (e) {
            fail(e);
        }
    };

    const changeSort = (value: ItemSort) => {
        setSort(value);
        if (current) void loadList(current.id, value, type);
    };
    const changeType = (value: string) => {
        setType(value);
        if (current) void loadList(current.id, sort, value);
    };
    const nearEnd = useCallback(() => {
        if (current && list.cursor && !listLoading && !results) void loadList(current.id, sort, type, list.cursor);
    }, [current, list.cursor, listLoading, results, loadList, sort, type]);

    const crumbs: ReactNode = (
        <nav className="small muted breadcrumb" aria-label={t('items.breadcrumb')}>
            {trail.map((c, i) => (
                <span key={c.id}>
                    {i > 0 ? ' › ' : ''}
                    {i < trail.length - 1 ? (
                        <button
                            type="button"
                            className="link"
                            onClick={() => void api.items.get(c.id).then(go).catch(fail)}
                        >
                            {c.title}
                        </button>
                    ) : (
                        c.title
                    )}
                </span>
            ))}
        </nav>
    );

    const shown = results ?? list.items;
    return (
        <div className="page items-page">
            <div className="row spread">
                <h1>{t('items.title')}</h1>
                <div className="row">
                    <button type="button" className="items-drawer-button" onClick={() => setDrawer(!drawer)}>
                        {t('items.categories')}
                    </button>
                    <button type="button" onClick={() => void sync()}>
                        {t('items.sync')}
                    </button>
                </div>
            </div>
            <p className="muted small">{t('items.hint')}</p>
            {error ? <p className="error">{error}</p> : null}
            <div className="items-layout">
                <nav className={`items-tree${drawer ? ' open' : ''}`} aria-label={t('items.categories')}>
                    {roots === null ? <p className="muted">{t('common.loading')}</p> : null}
                    {roots ? (
                        <TreeBranch
                            items={roots}
                            kids={kids}
                            expanded={expanded}
                            currentId={current?.id ?? null}
                            onToggle={toggle}
                            onGo={(i) => void go(i)}
                            onMore={(id) => void loadKids(id, kids[id]?.cursor ?? undefined).catch(fail)}
                        />
                    ) : null}
                </nav>
                <section className="item-main" aria-live="polite">
                    {current ? (
                        <>
                            {crumbs}
                            <div className="row item-tools">
                                <input
                                    type="search"
                                    value={query}
                                    placeholder={t('items.search')}
                                    aria-label={t('items.search')}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && void search()}
                                />
                                <select
                                    value={sort}
                                    aria-label={t('items.sort')}
                                    onChange={(e) => changeSort(e.target.value as ItemSort)}
                                >
                                    <option value="position">{t('items.sort.position')}</option>
                                    <option value="title">{t('items.sort.title')}</option>
                                    <option value="updatedAt">{t('items.sort.updated')}</option>
                                </select>
                                <select
                                    value={type}
                                    aria-label={t('items.type')}
                                    onChange={(e) => changeType(e.target.value)}
                                >
                                    <option value="">{t('items.type.all')}</option>
                                    {types.map((x) => (
                                        <option key={x} value={x}>
                                            {x}
                                        </option>
                                    ))}
                                </select>
                                <button type="button" onClick={() => ask(current, 'subtree')}>
                                    {t('items.askSubtree')}
                                </button>
                            </div>
                            {results ? (
                                <p className="small muted">
                                    {t('items.results').replace('{n}', String(results.length))}{' '}
                                    <button type="button" className="link" onClick={() => setResults(null)}>
                                        {t('items.clear')}
                                    </button>
                                </p>
                            ) : null}
                            {shown.length === 0 && !listLoading ? <p className="muted">{t('items.empty')}</p> : null}
                            <VirtualList items={shown} onPick={(i) => void pick(i)} onNearEnd={nearEnd} />
                            {list.cursor && !results ? (
                                <button type="button" className="link small" onClick={nearEnd}>
                                    {t('items.more')}
                                </button>
                            ) : null}
                        </>
                    ) : (
                        <p className="muted">{t('items.pick')}</p>
                    )}
                    {detail ? (
                        <article className="item-content">
                            <h2>{detail.title}</h2>
                            <p className="small muted">{detail.type}</p>
                            <button type="button" className="primary" onClick={() => ask(detail, 'item')}>
                                {t('items.ask')}
                            </button>
                            {content ? (
                                <>
                                    <pre className="item-text">{content.content}</pre>
                                    {content.truncated ? <p className="small muted">{t('items.truncated')}</p> : null}
                                </>
                            ) : detailError ? (
                                <p className="error small">{detailError}</p>
                            ) : (
                                <p className="muted">{t('common.loading')}</p>
                            )}
                            {related.length > 0 ? (
                                <div className="item-related">
                                    <h3>{t('items.related')}</h3>
                                    <ul className="list">
                                        {related.map((r) => (
                                            <li key={`${r.direction}-${r.rel}-${r.item.id}`}>
                                                <button
                                                    type="button"
                                                    className="link"
                                                    onClick={() => void pick(r.item)}
                                                >
                                                    {r.item.title}
                                                </button>{' '}
                                                <span className="small muted">{r.rel}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ) : null}
                        </article>
                    ) : null}
                </section>
            </div>
        </div>
    );
}
