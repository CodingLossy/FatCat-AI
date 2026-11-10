// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { FsRoot } from '@ai-personal/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';

/** 设置页中的授权目录:文件工具只能访问这里列出的文件夹(ADR 0011 第 1 节)。 */
export function FsRoots() {
    const { t } = useI18n();
    const [items, setItems] = useState<FsRoot[] | null>(null);
    const [newPath, setNewPath] = useState('');
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(
        () =>
            api.fsRoots
                .list()
                .then((page) => setItems(page.items))
                .catch((e: unknown) => setError(errorText(e))),
        [],
    );

    useEffect(() => {
        let alive = true;
        api.fsRoots
            .list()
            .then((page) => alive && setItems(page.items))
            .catch((e: unknown) => alive && setError(errorText(e)));
        return () => {
            alive = false;
        };
    }, []);

    const add = async (e: FormEvent) => {
        e.preventDefault();
        setError(null);
        try {
            await api.fsRoots.add({ path: newPath.trim() });
            setNewPath('');
        } catch (err) {
            setError(errorText(err));
        }
        await reload();
    };

    /** 是否进入知识库(默认不进入,ADR 0015 第 6 节)。 */
    const toggleKb = async (root: FsRoot, enabled: boolean) => {
        try {
            await api.fsRoots.update(root.id, { knowledgeBase: enabled });
        } catch (err) {
            setError(errorText(err));
        }
        await reload();
    };

    const remove = async (root: FsRoot) => {
        if (!window.confirm(t('fsRoots.removeConfirm', { path: root.path }))) return;
        try {
            await api.fsRoots.remove(root.id);
        } catch (err) {
            setError(errorText(err));
        }
        await reload();
    };

    return (
        <section>
            <h2>{t('fsRoots.title')}</h2>
            <p className="muted small">{t('fsRoots.hint')}</p>
            {error ? <p className="error">{error}</p> : null}
            {items?.length === 0 ? <p className="muted">{t('fsRoots.empty')}</p> : null}
            <ul className="list">
                {items?.map((r) => (
                    <li key={r.id} className="card row spread" data-fs-root={r.path}>
                        <div>
                            <strong>{r.label}</strong>
                            {r.label !== r.path ? <span className="small muted"> · {r.path}</span> : null}
                        </div>
                        <label className="small">
                            <input
                                type="checkbox"
                                checked={r.knowledgeBase}
                                onChange={(e) => void toggleKb(r, e.target.checked)}
                            />{' '}
                            {t('fsRoots.knowledgeBase')}
                        </label>
                        <button type="button" className="danger" onClick={() => void remove(r)}>
                            {t('fsRoots.remove')}
                        </button>
                    </li>
                ))}
            </ul>
            <form className="row" onSubmit={add}>
                <input
                    aria-label={t('fsRoots.path')}
                    placeholder={t('fsRoots.placeholder')}
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    spellCheck={false}
                    required
                />
                <button type="submit" className="primary">
                    {t('fsRoots.add')}
                </button>
            </form>
        </section>
    );
}
