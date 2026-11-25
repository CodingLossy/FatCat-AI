// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { FsRoot } from '@fatcat-ai/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { useIsAdmin } from './role.js';

/**
 * 设置页中的授权目录:文件工具只能访问这里列出的文件夹(ADR 0011 第 1 节)。
 * 2.0(ADR 0053 第 4.1 节):只有管理员能添加和删除;成员只看到管理员分给自己的文件夹,能选是否进知识库。
 * 给了 `account` 时是管理员在「账户」里管理分给这个账户的文件夹(没有知识库开关,那是成员自己的选择)。
 */
export function FsRoots({ account }: { account?: { id: string; username: string } } = {}) {
    const { t } = useI18n();
    const isAdmin = useIsAdmin();
    const [items, setItems] = useState<FsRoot[] | null>(null);
    const [newPath, setNewPath] = useState('');
    const [error, setError] = useState<string | null>(null);
    const accountId = account?.id;
    const list = useCallback(
        () => (accountId ? api.admin.users.fsRoots.list(accountId) : api.fsRoots.list()),
        [accountId],
    );

    const reload = useCallback(
        () =>
            list()
                .then((page) => setItems(page.items))
                .catch((e: unknown) => setError(errorText(e))),
        [list],
    );

    useEffect(() => {
        let alive = true;
        list()
            .then((page) => alive && setItems(page.items))
            .catch((e: unknown) => alive && setError(errorText(e)));
        return () => {
            alive = false;
        };
    }, [list]);

    const add = async (e: FormEvent) => {
        e.preventDefault();
        setError(null);
        try {
            const body = { path: newPath.trim() };
            await (accountId ? api.admin.users.fsRoots.assign(accountId, body) : api.fsRoots.add(body));
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
            await (accountId ? api.admin.users.fsRoots.remove(accountId, root.id) : api.fsRoots.remove(root.id));
        } catch (err) {
            setError(errorText(err));
        }
        await reload();
    };

    const manage = isAdmin === true;
    return (
        <section data-testid={account ? `account-folders-${account.username}` : undefined}>
            {account ? (
                <h3>{t('fsRoots.assignedTitle', { username: account.username })}</h3>
            ) : (
                <h2>{t('fsRoots.title')}</h2>
            )}
            {isAdmin === false ? <p className="small muted">{t('fsRoots.memberNote')}</p> : null}
            {error ? <p className="error">{error}</p> : null}
            {items?.length === 0 ? (
                <p className="muted">{account ? t('fsRoots.noneAssigned') : t('fsRoots.empty')}</p>
            ) : null}
            <ul className="list">
                {items?.map((r) => (
                    <li key={r.id} className="card row spread" data-fs-root={r.path}>
                        <div>
                            <strong>{r.label}</strong>
                            {r.label !== r.path ? <span className="small muted"> · {r.path}</span> : null}
                        </div>
                        {account ? null : (
                            <label className="small">
                                <input
                                    type="checkbox"
                                    checked={r.knowledgeBase}
                                    onChange={(e) => void toggleKb(r, e.target.checked)}
                                />{' '}
                                {t('fsRoots.knowledgeBase')}
                            </label>
                        )}
                        {manage ? (
                            <button type="button" className="danger" onClick={() => void remove(r)}>
                                {t('fsRoots.remove')}
                            </button>
                        ) : null}
                    </li>
                ))}
            </ul>
            {manage ? (
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
                        {account ? t('fsRoots.assign') : t('fsRoots.add')}
                    </button>
                </form>
            ) : null}
        </section>
    );
}
