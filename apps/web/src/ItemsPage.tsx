// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Item, ItemContent } from '@fatcat-ai/shared';
import { useEffect, useState } from 'react';
import { askAboutMail } from './MailPage.js';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';

/** 一个可展开的节点。每次展开都重新加载,这样新写入的记忆、邮件会立刻出现在树上(ADR 0012、ADR 0025)。 */
function TreeNode({ item, onOpen, selected }: { item: Item; onOpen: (item: Item) => void; selected: string | null }) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const [shown, setShown] = useState(item);
    const [children, setChildren] = useState<Item[] | null>(null);
    const [cursor, setCursor] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    if (shown.id !== item.id) setShown(item);

    const load = async (next?: string) => {
        try {
            const [fresh, page] = await Promise.all([
                next ? Promise.resolve(shown) : api.items.get(item.id),
                api.items.children(item.id, { limit: 100, ...(next ? { cursor: next } : {}) }),
            ]);
            if (!next) setShown(fresh);
            setChildren((old) => [...(next ? (old ?? []) : []), ...page.items]);
            setCursor(page.nextCursor);
            setError(null);
        } catch (e) {
            setError(errorText(e));
        }
    };

    const toggle = () => {
        if (!open) void load();
        setOpen(!open);
    };

    return (
        <li className="tree-node" data-item-type={item.type}>
            <div className={`tree-row${selected === item.id ? ' active' : ''}`}>
                {shown.kind === 'category' ? (
                    <button type="button" className="link tree-toggle" aria-expanded={open} onClick={toggle}>
                        {open ? '▾' : '▸'} {shown.title}
                    </button>
                ) : (
                    <button type="button" className="link tree-leaf" onClick={() => onOpen(shown)}>
                        {shown.title}
                    </button>
                )}
                {shown.kind === 'category' ? <span className="small muted"> ({shown.contentCount ?? 0})</span> : null}
            </div>
            {error ? <p className="error small">{error}</p> : null}
            {open && children ? (
                <ul className="tree">
                    {children.length === 0 ? <li className="small muted">{t('items.empty')}</li> : null}
                    {children.map((c) => (
                        <TreeNode key={c.id} item={c} onOpen={onOpen} selected={selected} />
                    ))}
                    {cursor ? (
                        <li>
                            <button type="button" className="link small" onClick={() => void load(cursor)}>
                                {t('items.more')}
                            </button>
                        </li>
                    ) : null}
                </ul>
            ) : null}
        </li>
    );
}

/** 知识地图的最简只读树形浏览:顶层类别 → 逐层展开 → 打开条目(M5 再做完整的分类浏览器)。 */
export function ItemsPage() {
    const { t } = useI18n();
    const [roots, setRoots] = useState<Item[] | null>(null);
    const [selected, setSelected] = useState<Item | null>(null);
    const [trail, setTrail] = useState<Item[]>([]);
    const [content, setContent] = useState<ItemContent | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let alive = true;
        api.items
            .roots()
            .then((page) => alive && setRoots(page.items))
            .catch((e: unknown) => alive && setError(errorText(e)));
        return () => {
            alive = false;
        };
    }, [reloadKey]);

    const open = async (item: Item) => {
        setSelected(item);
        setContent(null);
        setError(null);
        try {
            const [ancestors, body] = await Promise.all([api.items.ancestors(item.id), api.items.content(item.id)]);
            setTrail(ancestors.items);
            setContent(body);
        } catch (e) {
            setError(errorText(e));
        }
    };

    const sync = async () => {
        try {
            await api.items.sync();
            setRoots(null);
            setReloadKey((k) => k + 1);
        } catch (e) {
            setError(errorText(e));
        }
    };

    return (
        <div className="page items-page">
            <div className="row spread">
                <h1>{t('items.title')}</h1>
                <button type="button" onClick={() => void sync()}>
                    {t('items.sync')}
                </button>
            </div>
            <p className="muted small">{t('items.hint')}</p>
            {error ? <p className="error">{error}</p> : null}
            <div className="items-layout">
                <nav aria-label={t('items.title')}>
                    {roots === null ? <p className="muted">{t('common.loading')}</p> : null}
                    <ul className="tree" key={reloadKey}>
                        {roots?.map((r) => (
                            <TreeNode
                                key={r.id}
                                item={r}
                                onOpen={(i) => void open(i)}
                                selected={selected?.id ?? null}
                            />
                        ))}
                    </ul>
                </nav>
                <section className="item-content" aria-live="polite">
                    {selected ? (
                        <>
                            <p className="small muted breadcrumb">
                                {[...trail.map((a) => a.title), selected.title].join(' › ')}
                            </p>
                            {selected.type === 'mail.message' ? (
                                <button
                                    type="button"
                                    className="primary"
                                    onClick={() =>
                                        void askAboutMail(String((selected.meta as { messageId?: string }).messageId))
                                    }
                                >
                                    {t('mail.ask')}
                                </button>
                            ) : null}
                            {content ? (
                                <>
                                    <pre className="item-text">{content.content}</pre>
                                    {content.truncated ? <p className="small muted">{t('items.truncated')}</p> : null}
                                </>
                            ) : error ? null : (
                                <p className="muted">{t('common.loading')}</p>
                            )}
                        </>
                    ) : (
                        <p className="muted">{t('items.pick')}</p>
                    )}
                </section>
            </div>
        </div>
    );
}
