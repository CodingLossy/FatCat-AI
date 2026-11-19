// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 顶栏的全局搜索(ui-redesign.md 第 5 节):一个框、三组结果。文件 = 条目索引搜索(GET /api/v1/items/search);
// 命令 = 客户端静态列表;其余内容作为问题预填到当前会话的输入框(不自动发送,也不会去搜网络)。Ctrl/Cmd+K 聚焦。
import type { Item } from '@fatcat-ai/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, errorText } from './api.js';
import { Icon } from './Icon.js';
import { useI18n, type Key } from './i18n.js';
import { itemTitle } from './item-title.js';
import { navigate, parseRoute, type Route } from './router.js';
import { filterCommands, type CommandItem } from './workbench.js';

const COMMANDS: { id: string; key: Key; route: Route }[] = [
    { id: 'new', key: 'wb.cmd.newChat', route: { name: 'home' } },
    { id: 'settings', key: 'wb.cmd.settings', route: { name: 'settings' } },
    { id: 'memory', key: 'wb.cmd.memory', route: { name: 'memory' } },
    { id: 'mail', key: 'wb.cmd.mail', route: { name: 'mail' } },
    { id: 'items', key: 'wb.cmd.items', route: { name: 'items' } },
    { id: 'tasks', key: 'wb.cmd.tasks', route: { name: 'tasks' } },
];

export const ASK_EVENT = 'fatcat-ask';

/** 把文字放进当前会话的输入框;不在聊天页时先回到首页再预填。只预填,从不自动发送。 */
export function askInChat(text: string): void {
    const route = parseRoute(window.location.pathname);
    if (route.name === 'home' || route.name === 'session') {
        window.dispatchEvent(new CustomEvent<string>(ASK_EVENT, { detail: text }));
        return;
    }
    window.history.pushState(null, '', `/?ask=${encodeURIComponent(text.slice(0, 2000))}`);
    navigate({ name: 'home' });
}

type Row =
    | { kind: 'file'; key: string; label: string; detail: string; run: () => void }
    | { kind: 'command'; key: string; label: string; detail: string; run: () => void }
    | { kind: 'ask'; key: string; label: string; detail: string; run: () => void };

export function GlobalSearch() {
    const { t } = useI18n();
    const inputRef = useRef<HTMLInputElement>(null);
    const listId = useId();
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const [files, setFiles] = useState<Item[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [active, setActive] = useState(0);

    // Ctrl/Cmd+K 聚焦搜索框
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                inputRef.current?.focus();
                inputRef.current?.select();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    // 让导轨上的搜索图标也能聚焦
    useEffect(() => {
        const focus = () => inputRef.current?.focus();
        window.addEventListener('fatcat-focus-search', focus);
        return () => window.removeEventListener('fatcat-focus-search', focus);
    }, []);

    // 文件搜索:输入停顿 250ms 后才发请求,至少 2 个字符,新输入会取消上一次
    useEffect(() => {
        const q = query.trim();
        if (q.length < 2) return;
        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            api.items
                .search({ q, limit: 6 })
                .then((page) => {
                    if (controller.signal.aborted) return;
                    setFiles(page.items);
                    setError(null);
                })
                .catch((e: unknown) => {
                    if (controller.signal.aborted) return;
                    setFiles([]);
                    setError(errorText(e));
                });
        }, 250);
        return () => {
            controller.abort();
            window.clearTimeout(timer);
        };
    }, [query]);

    const close = () => {
        setOpen(false);
        setActive(0);
    };
    const rows: Row[] = useMemo(() => {
        const q = query.trim();
        if (!q) return [];
        const commands: CommandItem[] = COMMANDS.map((c) => ({ id: c.id, label: t(c.key) }));
        const out: Row[] = [];
        if (q.length >= 2) {
            for (const item of files) {
                out.push({
                    kind: 'file',
                    key: `f-${item.id}`,
                    label: itemTitle(item, t),
                    detail: item.type,
                    run: () => navigate({ name: 'items' }),
                });
            }
        }
        for (const cmd of filterCommands(commands, q)) {
            const route = COMMANDS.find((c) => c.id === cmd.id)!.route;
            out.push({ kind: 'command', key: `c-${cmd.id}`, label: cmd.label, detail: '', run: () => navigate(route) });
        }
        out.push({
            kind: 'ask',
            key: 'ask',
            label: t('wb.search.askItem', { q }),
            detail: '',
            run: () => askInChat(q),
        });
        return out;
    }, [query, files, t]);

    const choose = (row: Row | undefined) => {
        if (!row) return;
        row.run();
        setQuery('');
        close();
        inputRef.current?.blur();
    };

    const groups: { kind: Row['kind']; title: Key }[] = [
        { kind: 'file', title: 'wb.search.files' },
        { kind: 'command', title: 'wb.search.commands' },
        { kind: 'ask', title: 'wb.search.ask' },
    ];
    const showFileEmpty =
        query.trim().length >= 2 && files.length === 0 && !error && rows.every((r) => r.kind === 'ask');

    return (
        <div className="global-search" role="search">
            <Icon name="search" size={16} />
            <input
                ref={inputRef}
                type="search"
                role="combobox"
                aria-expanded={open && rows.length > 0}
                aria-controls={listId}
                aria-label={t('wb.search.label')}
                placeholder={t('wb.search.placeholder')}
                value={query}
                maxLength={200}
                onChange={(e) => {
                    setQuery(e.target.value);
                    setOpen(true);
                    setActive(0);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => window.setTimeout(close, 120)}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                        close();
                        inputRef.current?.blur();
                    } else if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setActive((a) => Math.min(rows.length - 1, a + 1));
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setActive((a) => Math.max(0, a - 1));
                    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        choose(rows[active]);
                    }
                }}
            />
            <kbd className="search-hint" aria-hidden="true">
                Ctrl K
            </kbd>
            {open && rows.length > 0 ? (
                <div className="search-results" id={listId} role="listbox">
                    {groups.map((g) => {
                        const items = rows.filter((r) => r.kind === g.kind);
                        if (items.length === 0) return null;
                        return (
                            <div key={g.kind} className="search-group">
                                <h3>{t(g.title)}</h3>
                                {items.map((row) => (
                                    <button
                                        key={row.key}
                                        type="button"
                                        role="option"
                                        aria-selected={rows[active]?.key === row.key}
                                        className={`search-row${rows[active]?.key === row.key ? ' active' : ''}`}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => choose(row)}
                                    >
                                        <span>{row.label}</span>
                                        {row.detail ? <span className="small muted">{row.detail}</span> : null}
                                    </button>
                                ))}
                            </div>
                        );
                    })}
                    {error ? <p className="small error">{t('wb.search.failed', { msg: error })}</p> : null}
                    {showFileEmpty ? <p className="small muted">{t('wb.search.none')}</p> : null}
                </div>
            ) : null}
        </div>
    );
}
