// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ApprovalRequest } from '@fatcat-ai/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { ApprovalActions } from './ApprovalActions.js';
import { useI18n } from './i18n.js';
import { navigate } from './router.js';
import { ApprovalWarnings, show } from './ToolCard.js';

/** 兜底轮询间隔:WebSocket 断开时也能看到新的审批请求。 */
const POLL_MS = 15_000;

/**
 * 全局审批面板(ADR 0010 第 5 节):列出其他会话中等待批准的工具调用。当前打开的会话已在聊天卡片中显示,这里不重复。
 * 通过 WebSocket 事件即时刷新,另有低频轮询兜底。
 */
export function ApprovalPanel({ currentSessionId }: { currentSessionId: string | null }) {
    const { t } = useI18n();
    const [pending, setPending] = useState<ApprovalRequest[]>([]);
    const [open, setOpen] = useState(false);

    const reload = useCallback(
        () =>
            api.approvals
                .list({ status: 'pending', limit: 50 })
                .then((page) => setPending(page.items))
                .catch(() => undefined),
        [],
    );

    useEffect(() => {
        let alive = true;
        const refresh = () => {
            if (alive) void reload();
        };
        refresh();
        const timer = setInterval(refresh, POLL_MS);
        let connection: { close(): void } | null = null;
        try {
            connection = api.connectEvents({
                onEvent: (envelope) => {
                    const type = envelope.event.type;
                    if (type === 'approval-required' || type === 'approval-resolved') refresh();
                },
            });
        } catch {
            // 浏览器不支持或连接失败时只靠轮询
        }
        return () => {
            alive = false;
            clearInterval(timer);
            connection?.close();
        };
    }, [reload]);

    const others = pending.filter((a) => a.sessionId !== currentSessionId);
    if (others.length === 0) return null;

    return (
        <div className="approval-panel" role="region" aria-label={t('approvals.title')}>
            <button type="button" className="link" onClick={() => setOpen(!open)}>
                {t('approvals.waiting', { n: others.length })}
            </button>
            {open ? (
                <ul className="list">
                    {others.map((a) => (
                        <li
                            key={a.callId}
                            className={`card tool-card pending${a.warnings?.length ? ' warned' : ''}`}
                            data-call-id={a.callId}
                        >
                            <div className="tool-title">{t('tool.call', { name: a.toolName })}</div>
                            <p className="tool-summary">{a.summary}</p>
                            <ApprovalWarnings warnings={a.warnings} />
                            <details>
                                <summary className="small muted">input</summary>
                                <pre>{show(a.input)}</pre>
                            </details>
                            <div className="row">
                                <button
                                    type="button"
                                    className="link small"
                                    onClick={() => navigate({ name: 'session', id: a.sessionId })}
                                >
                                    {t('approvals.openSession')}
                                </button>
                                <span className="small muted">
                                    {t('approvals.expires', { time: new Date(a.expiresAt).toLocaleTimeString() })}
                                </span>
                            </div>
                            <ApprovalActions
                                callId={a.callId}
                                risk={a.risk}
                                toolName={a.toolName}
                                input={a.input}
                                onDecided={() => void reload()}
                            />
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}
