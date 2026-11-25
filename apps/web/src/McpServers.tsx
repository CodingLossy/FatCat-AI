// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { McpServerView } from '@fatcat-ai/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { useIsAdmin } from './role.js';

/** 设置页中的 MCP 服务器(ADR 0013):只能由用户增删;连接在后台进行,这里定时刷新状态。 */
export function McpServers() {
    const { t } = useI18n();
    // stdio 服务器会在服务器上起进程,2.0 只有管理员能添加和启用(ADR 0053 第 4 节);删除谁都能做
    const isAdmin = useIsAdmin();
    const manage = isAdmin === true;
    const [items, setItems] = useState<McpServerView[] | null>(null);
    const [name, setName] = useState('');
    const [command, setCommand] = useState('');
    const [args, setArgs] = useState('');
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(
        () =>
            api.mcpServers
                .list()
                .then((page) => setItems(page.items))
                .catch((e: unknown) => setError(errorText(e))),
        [],
    );

    useEffect(() => {
        void reload();
    }, [reload]);

    // 有服务器正在连接时每秒刷新一次
    const connecting = items?.some((s) => s.status.state === 'connecting') ?? false;
    useEffect(() => {
        if (!connecting) return;
        const timer = setInterval(() => void reload(), 1000);
        return () => clearInterval(timer);
    }, [connecting, reload]);

    const run = async (action: () => Promise<unknown>) => {
        setError(null);
        try {
            await action();
        } catch (err) {
            setError(errorText(err));
        }
        await reload();
    };

    const add = (e: FormEvent) => {
        e.preventDefault();
        void run(async () => {
            await api.mcpServers.add({
                name: name.trim(),
                command: command.trim(),
                args: args
                    .split('\n')
                    .map((a) => a.trim())
                    .filter((a) => a.length > 0),
            });
            setName('');
            setCommand('');
            setArgs('');
        });
    };

    const remove = (server: McpServerView) => {
        if (!window.confirm(t('mcp.removeConfirm', { name: server.name }))) return;
        void run(() => api.mcpServers.remove(server.id));
    };

    return (
        <section>
            <h2>{t('mcp.title')}</h2>
            {isAdmin === false ? (
                <p className="muted small" data-testid="admin-only">
                    {t('admin.onlyNote')}
                </p>
            ) : null}
            {error ? <p className="error">{error}</p> : null}
            {items?.length === 0 ? <p className="muted">{t('mcp.empty')}</p> : null}
            <ul className="list">
                {items?.map((s) => (
                    <li key={s.id} className="card row spread" data-mcp-server={s.name}>
                        <div>
                            <strong>{s.name}</strong>
                            <span className="small muted">
                                {' · '}
                                {t(`mcp.state.${s.status.state}`)}
                                {s.status.state === 'connected'
                                    ? ` · ${t('mcp.tools', { n: s.status.tools.length })}`
                                    : ''}
                            </span>
                            <div className="small muted">{[s.command, ...s.args].join(' ')}</div>
                            {s.status.error ? <div className="small error">{s.status.error}</div> : null}
                        </div>
                        <div className="row">
                            {manage ? (
                                <button
                                    type="button"
                                    onClick={() => void run(() => api.mcpServers.update(s.id, { enabled: !s.enabled }))}
                                >
                                    {s.enabled ? t('mcp.disable') : t('mcp.enable')}
                                </button>
                            ) : null}
                            <button type="button" className="danger" onClick={() => remove(s)}>
                                {t('mcp.remove')}
                            </button>
                        </div>
                    </li>
                ))}
            </ul>
            {manage ? (
                <form className="card form" onSubmit={add}>
                    <input
                        aria-label={t('mcp.name')}
                        placeholder={t('mcp.name')}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        pattern="[a-z0-9_\-]{1,32}"
                        spellCheck={false}
                        required
                    />
                    <input
                        aria-label={t('mcp.command')}
                        placeholder={t('mcp.command')}
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        spellCheck={false}
                        required
                    />
                    <textarea
                        aria-label={t('mcp.args')}
                        placeholder={t('mcp.args')}
                        value={args}
                        onChange={(e) => setArgs(e.target.value)}
                        rows={3}
                        spellCheck={false}
                    />
                    <button type="submit" className="primary">
                        {t('mcp.add')}
                    </button>
                </form>
            ) : null}
        </section>
    );
}
