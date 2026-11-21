// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type {
    ConflictResolution,
    Memory,
    MemoryConflict,
    MemorySource,
    QuarantinedMemory,
    Settings,
} from '@fatcat-ai/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { AutoExtractNotice } from './AutoExtractNotice.js';
import { MemorySources } from './MemorySources.js';

function MemoryItem({ memory, onChanged }: { memory: Memory; onChanged: () => Promise<void> }) {
    const { t, locale } = useI18n();
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(memory.text);
    const [error, setError] = useState<string | null>(null);
    const [history, setHistory] = useState<Memory[] | null>(null);
    const [sources, setSources] = useState<MemorySource[] | null>(null);
    const [loadingSources, setLoadingSources] = useState(false);

    const toggleHistory = async () => {
        if (history) return setHistory(null);
        try {
            setHistory((await api.memory.history(memory.id)).items);
        } catch (err) {
            setError(errorText(err));
        }
    };

    /** 点开才请求,避免列表里每条记忆都发一次请求。 */
    const toggleSources = async () => {
        if (sources) return setSources(null);
        setLoadingSources(true);
        try {
            setSources((await api.memory.sources(memory.id)).items);
            setError(null);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setLoadingSources(false);
        }
    };

    const save = async (e: FormEvent) => {
        e.preventDefault();
        try {
            await api.memory.update(memory.id, { text });
            setEditing(false);
            await onChanged();
        } catch (err) {
            setError(errorText(err));
        }
    };

    const remove = async () => {
        if (!window.confirm(t('memory.deleteConfirm'))) return;
        try {
            await api.memory.delete(memory.id);
            await onChanged();
        } catch (err) {
            setError(errorText(err));
        }
    };

    return (
        <li className="card memory" data-memory-id={memory.id}>
            {editing ? (
                <form className="row" onSubmit={save}>
                    <input
                        aria-label={t('memory.edit')}
                        value={text}
                        minLength={2}
                        maxLength={200}
                        onChange={(e) => setText(e.target.value)}
                    />
                    <button type="submit" className="primary">
                        {t('memory.save')}
                    </button>
                    <button type="button" onClick={() => setEditing(false)}>
                        {t('memory.cancel')}
                    </button>
                </form>
            ) : (
                <p className="memory-text">{memory.text}</p>
            )}
            <div className="small muted">
                {t('memory.type')}: {memory.memType}
                {memory.subtype ? `/${memory.subtype}` : ''} · {t('memory.domain')}: {memory.domain} ·{' '}
                {t('memory.origin')}: {memory.origin} · {t('memory.status')}: {memory.status} · {t('memory.confidence')}
                : {memory.confidence.toFixed(2)} · {t('memory.updated')}:{' '}
                {new Date(memory.updatedAt).toLocaleString(locale)}
            </div>
            {editing ? null : (
                <div className="row">
                    <button type="button" onClick={() => setEditing(true)}>
                        {t('memory.edit')}
                    </button>
                    <button type="button" onClick={() => void toggleHistory()}>
                        {t('memory.history')}
                    </button>
                    <button type="button" disabled={loadingSources} onClick={() => void toggleSources()}>
                        {t('memory.sources')}
                    </button>
                    <button type="button" className="danger" onClick={() => void remove()}>
                        {t('memory.delete')}
                    </button>
                </div>
            )}
            {history ? (
                <ol className="small memory-history" data-testid="memory-history">
                    {history.map((h) => (
                        <li key={h.id} className={h.id === memory.id ? 'current' : ''}>
                            {h.text} · {h.status}
                        </li>
                    ))}
                </ol>
            ) : null}
            {sources ? <MemorySources sources={sources} /> : null}
            {error ? <p className="error small">{error}</p> : null}
        </li>
    );
}

function Conflicts({ onChanged }: { onChanged: () => Promise<void> }) {
    const { t } = useI18n();
    const [items, setItems] = useState<MemoryConflict[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [version, setVersion] = useState(0);
    const load = useCallback(() => setVersion((v) => v + 1), []);
    useEffect(() => {
        let alive = true;
        api.memory
            .conflicts()
            .then((page) => alive && setItems(page.items))
            .catch((e: unknown) => alive && setError(errorText(e)));
        return () => {
            alive = false;
        };
    }, [version]);
    const resolve = async (id: string, resolution: ConflictResolution) => {
        try {
            await api.memory.resolveConflict(id, { resolution });
            load();
            await onChanged();
        } catch (e) {
            setError(errorText(e));
        }
    };
    if (items.length === 0 && !error) return null;
    return (
        <section className="card" data-testid="memory-conflicts">
            <h2>{t('memory.conflicts')}</h2>
            {error ? <p className="error small">{error}</p> : null}
            <ul className="list">
                {items.map((c) => (
                    <li key={c.id}>
                        <p>
                            A:{c.a.text}
                            <br />
                            B:{c.b.text}
                        </p>
                        <div className="row">
                            <button type="button" onClick={() => void resolve(c.id, 'kept_a')}>
                                {t('memory.keepA')}
                            </button>
                            <button type="button" onClick={() => void resolve(c.id, 'kept_b')}>
                                {t('memory.keepB')}
                            </button>
                            <button type="button" onClick={() => void resolve(c.id, 'both_valid')}>
                                {t('memory.bothValid')}
                            </button>
                            <button type="button" onClick={() => void resolve(c.id, 'dismissed')}>
                                {t('memory.dismiss')}
                            </button>
                        </div>
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** 隔离区条目的文本:raw 是已脱敏的原始输入,按纯文本显示。 */
function rawText(raw: unknown): string {
    const text = (raw as { text?: unknown } | null)?.text;
    return typeof text === 'string' ? text : JSON.stringify(raw);
}

function Quarantine({ onChanged }: { onChanged: () => Promise<void> }) {
    const { t } = useI18n();
    const [items, setItems] = useState<QuarantinedMemory[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [version, setVersion] = useState(0);
    const load = useCallback(() => setVersion((v) => v + 1), []);
    useEffect(() => {
        let alive = true;
        api.memory
            .quarantine()
            .then((page) => alive && setItems(page.items))
            .catch((e: unknown) => alive && setError(errorText(e)));
        return () => {
            alive = false;
        };
    }, [version]);
    const promote = async (id: string) => {
        try {
            const result = await api.memory.promote(id);
            setError(
                result.outcome === 'refused' || result.outcome === 'quarantined' ? t('memory.promoteFailed') : null,
            );
            load();
            await onChanged();
        } catch (e) {
            setError(errorText(e));
        }
    };
    if (items.length === 0 && !error) return null;
    return (
        <section className="card" data-testid="memory-quarantine">
            <h2>{t('memory.quarantine')}</h2>
            <p className="small muted">{t('memory.quarantineHint')}</p>
            {error ? <p className="error small">{error}</p> : null}
            <ul className="list">
                {items.map((q) => (
                    <li key={q.id} className="row">
                        <span>
                            {rawText(q.raw)} <span className="small muted">({t(`memory.reason.${q.reason}`)})</span>
                        </span>
                        <button type="button" onClick={() => void promote(q.id)}>
                            {t('memory.promote')}
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}

export function MemoryPage({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
    const { t } = useI18n();
    const [stopped, setStopped] = useState(false);
    const [switchError, setSwitchError] = useState<string | null>(null);
    const turnOffAutoExtract = async () => {
        setSwitchError(null);
        try {
            onSettings(await api.settings.update({ memory: { autoExtract: false } }));
            setStopped(true);
        } catch (e) {
            setSwitchError(errorText(e));
        }
    };
    const [items, setItems] = useState<Memory[] | null>(null);
    const [query, setQuery] = useState('');
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        try {
            const q = query.trim();
            setItems(
                q
                    ? (await api.memory.search({ query: q, limit: 30 })).items
                    : (await api.memory.list({ limit: 200 })).items,
            );
            setError(null);
        } catch (e) {
            setError(errorText(e));
        }
    }, [query]);

    useEffect(() => {
        const timer = setTimeout(() => void reload(), 200);
        return () => clearTimeout(timer);
    }, [reload]);

    return (
        <div className="page">
            <h1>{t('memory.title')}</h1>
            <input
                type="search"
                className="search"
                aria-label={t('memory.search')}
                placeholder={t('memory.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            <AutoExtractNotice
                autoExtract={settings.memory.autoExtract}
                stopped={stopped}
                error={switchError}
                onTurnOff={() => void turnOffAutoExtract()}
            />
            {error ? <p className="error">{error}</p> : null}
            <Conflicts onChanged={reload} />
            <Quarantine onChanged={reload} />
            {items === null ? <p className="muted">{t('common.loading')}</p> : null}
            {items?.length === 0 ? <p className="muted">{t('memory.empty')}</p> : null}
            <ul className="list">
                {items?.map((m) => (
                    <MemoryItem key={`${m.id}:${m.updatedAt}`} memory={m} onChanged={reload} />
                ))}
            </ul>
        </div>
    );
}
