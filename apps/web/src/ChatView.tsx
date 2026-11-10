// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { RunStream } from '@ai-personal/client';
import type { Message } from '@ai-personal/shared';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { applyEvent, newTurn, type LiveTool, type LiveTurn } from './live-turn.js';
import { Markdown } from './Markdown.js';
import { navigate } from './router.js';
import { ToolCard } from './ToolCard.js';
import { UsedMemories } from './UsedMemories.js';

/** 新对话:先建会话再跳转,跳转后的 ChatView 负责发送这条消息。 */
let pendingSend: { sessionId: string; text: string } | null = null;

/** 把保存的消息拆成工具卡片;工具结果可能在同一条或后面的消息里。 */
function toolsOf(message: Message, results: Map<string, LiveTool['result']>): LiveTool[] {
    return message.parts.flatMap((p) => {
        if (p.type !== 'tool-call') return [];
        const result = results.get(p.callId);
        return [{ callId: p.callId, name: p.name, input: p.input, ...(result ? { result } : {}) }];
    });
}

function textOf(message: Message): string {
    return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

export function ChatView({
    sessionId,
    onSessionsChanged,
}: {
    sessionId: string | null;
    onSessionsChanged: () => Promise<void>;
}) {
    const { t } = useI18n();
    const [messages, setMessages] = useState<Message[]>([]);
    const [live, setLive] = useState<LiveTurn | null>(null);
    // 从邮件「问 AI」进来时预填建议的第一句话(只含邮件 id)
    const [input, setInput] = useState(() => {
        if (!sessionId) return '';
        try {
            const key = 'aip.prefill.' + sessionId;
            const text = sessionStorage.getItem(key) ?? '';
            sessionStorage.removeItem(key);
            return text;
        } catch {
            return '';
        }
    });
    const [error, setError] = useState<string | null>(null);
    /** 最近一轮用到的记忆;下一轮开始时清空。 */
    const [used, setUsed] = useState<{ runId: string | null; ids: string[] } | null>(null);
    const abort = useRef<AbortController | null>(null);
    const bottom = useRef<HTMLDivElement>(null);

    const loadMessages = useCallback(async (id: string, hideRunId: string | null) => {
        const page = await api.sessions.messages(id, { limit: 200 });
        setMessages(page.items.filter((m) => !(hideRunId && m.runId === hideRunId && m.role === 'assistant')));
    }, []);

    /** 读完一次运行的事件流;结束后以服务器保存的消息为准。 */
    const consume = useCallback(
        async (id: string, stream: RunStream, turn: LiveTurn, signal: AbortSignal) => {
            let current = turn;
            setLive(current);
            setUsed(null);
            try {
                for await (const envelope of stream) {
                    current = applyEvent(current, envelope);
                    setLive(current);
                }
            } catch (e) {
                if (signal.aborted) return;
                setError(errorText(e));
            }
            if (signal.aborted) return;
            if (current.error) setError(current.error.detail ?? current.error.title);
            await loadMessages(id, null).catch(() => undefined);
            if (current.memoryIds.length > 0) setUsed({ runId: current.runId, ids: current.memoryIds });
            setLive(null);
            void onSessionsChanged();
        },
        [loadMessages, onSessionsChanged],
    );

    const send = useCallback(
        async (id: string, text: string, signal: AbortSignal) => {
            setError(null);
            await consume(id, api.sessions.send(id, { text }, { signal }), newTurn(text), signal);
        },
        [consume],
    );

    useEffect(() => {
        const controller = new AbortController();
        abort.current = controller;
        if (!sessionId) return () => controller.abort();
        const { signal } = controller;
        void (async () => {
            try {
                const session = await api.sessions.get(sessionId);
                if (signal.aborted) return;
                await loadMessages(sessionId, session.activeRunId);
                if (pendingSend?.sessionId === sessionId) {
                    const { text } = pendingSend;
                    pendingSend = null;
                    await send(sessionId, text, signal);
                } else if (session.activeRunId) {
                    // 刷新或换页回来:从头补发这次运行的事件,重建进行中的一轮(ADR 0009 第 3 节)
                    const runId = session.activeRunId;
                    await consume(sessionId, api.runs.events(runId, 0, { signal }), newTurn(null, runId), signal);
                }
            } catch (e) {
                if (!signal.aborted) setError(errorText(e));
            }
        })();
        return () => controller.abort();
    }, [sessionId, loadMessages, consume, send]);

    useEffect(() => {
        bottom.current?.scrollIntoView?.({ block: 'end' });
    }, [messages, live]);

    const submit = async () => {
        const text = input.trim();
        if (!text || live) return;
        setInput('');
        if (sessionId && abort.current) {
            await send(sessionId, text, abort.current.signal);
            return;
        }
        try {
            const session = await api.sessions.create();
            pendingSend = { sessionId: session.id, text };
            await onSessionsChanged();
            navigate({ name: 'session', id: session.id }, true);
        } catch (e) {
            setError(errorText(e));
        }
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
        }
    };

    const stop = async () => {
        if (live?.runId) await api.runs.cancel(live.runId).catch((e: unknown) => setError(errorText(e)));
    };

    const deleteSession = async () => {
        if (!sessionId || !window.confirm(t('chat.deleteConfirm'))) return;
        await api.sessions.delete(sessionId).catch((e: unknown) => setError(errorText(e)));
        await onSessionsChanged();
        navigate({ name: 'home' });
    };

    const results = new Map<string, LiveTool['result']>();
    for (const m of messages) {
        for (const p of m.parts) {
            if (p.type === 'tool-result')
                results.set(p.callId, { output: p.output, ...(p.error ? { error: p.error } : {}) });
        }
    }

    return (
        <div className="chat">
            {sessionId ? (
                <div className="chat-head">
                    <button type="button" className="link small" onClick={() => void deleteSession()}>
                        {t('chat.delete')}
                    </button>
                </div>
            ) : null}
            <div className="messages" data-testid="messages">
                {messages.length === 0 && !live ? <p className="muted empty">{t('chat.empty')}</p> : null}
                {messages.map((m) => (
                    <div key={m.id} className={`message ${m.role}`} data-status={m.status}>
                        {m.role === 'user' ? <p className="user-text">{textOf(m)}</p> : <Markdown text={textOf(m)} />}
                        {toolsOf(m, results).map((tool) => (
                            <ToolCard key={tool.callId} tool={tool} />
                        ))}
                        {m.status === 'cancelled' ? <p className="small muted">{t('chat.cancelled')}</p> : null}
                    </div>
                ))}
                {live?.userText ? (
                    <div className="message user">
                        <p className="user-text">{live.userText}</p>
                    </div>
                ) : null}
                {live ? (
                    <div className="message assistant live" data-testid="live" aria-live="polite">
                        {live.text ? <Markdown text={live.text} /> : null}
                        {live.tools.map((tool) => (
                            <ToolCard key={tool.callId} tool={tool} live />
                        ))}
                        {!live.text && live.tools.length === 0 ? (
                            <p className="muted small">{t('chat.thinking')}</p>
                        ) : null}
                    </div>
                ) : null}
                {used && !live ? <UsedMemories key={used.runId ?? ''} runId={used.runId} ids={used.ids} /> : null}
                {error ? <p className="error">{t('chat.failed', { msg: error })}</p> : null}
                <div ref={bottom} />
            </div>
            <div className="composer">
                <textarea
                    aria-label={t('chat.placeholder')}
                    placeholder={t('chat.placeholder')}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    rows={3}
                />
                {live ? (
                    <button type="button" onClick={() => void stop()} disabled={!live.runId}>
                        {t('chat.stop')}
                    </button>
                ) : (
                    <button type="button" className="primary" onClick={() => void submit()} disabled={!input.trim()}>
                        {t('chat.send')}
                    </button>
                )}
            </div>
        </div>
    );
}
