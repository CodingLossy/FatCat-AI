// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 「本次用到的记忆」面板,带反馈按钮(《记忆模块补充设计》第 6 节;ADR 0007 第 5.8 节)。
// 记忆正文按纯文本显示。
import type { FeedbackSignal, Memory } from '@fatcat-ai/shared';
import { useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';

function UsedMemory({ memory, runId }: { memory: Memory; runId: string | null }) {
    const { t } = useI18n();
    const [status, setStatus] = useState<string | null>(null);
    const [correcting, setCorrecting] = useState(false);
    const [correction, setCorrection] = useState('');

    const send = async (signal: FeedbackSignal, fix?: string) => {
        try {
            const result = await api.memory.feedback(memory.id, {
                signal,
                ...(fix ? { correction: fix } : {}),
                ...(runId ? { runId } : {}),
            });
            setStatus(t(`feedback.done.${result.outcome}`));
            setCorrecting(false);
        } catch (e) {
            setStatus(errorText(e));
        }
    };

    return (
        <li className="used-memory" data-memory-id={memory.id}>
            <span className="memory-text">{memory.text}</span>
            {status ? (
                <span className="small muted feedback-status"> · {status}</span>
            ) : correcting ? (
                <form
                    className="row"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (correction.trim()) void send('wrong', correction.trim());
                    }}
                >
                    <input
                        aria-label={t('feedback.correction')}
                        placeholder={t('feedback.correction')}
                        value={correction}
                        maxLength={200}
                        onChange={(e) => setCorrection(e.target.value)}
                    />
                    <button type="submit" className="primary">
                        {t('memory.save')}
                    </button>
                    <button type="button" onClick={() => void send('wrong')}>
                        {t('feedback.noCorrection')}
                    </button>
                </form>
            ) : (
                <span className="row feedback-buttons">
                    <button type="button" className="link small" onClick={() => void send('helpful')}>
                        {t('feedback.helpful')}
                    </button>
                    <button type="button" className="link small" onClick={() => void send('stale')}>
                        {t('feedback.stale')}
                    </button>
                    <button type="button" className="link small" onClick={() => setCorrecting(true)}>
                        {t('feedback.wrong')}
                    </button>
                    <button
                        type="button"
                        className="link small"
                        onClick={() => {
                            if (window.confirm(t('feedback.sensitiveConfirm'))) void send('sensitive');
                        }}
                    >
                        {t('feedback.sensitive')}
                    </button>
                </span>
            )}
        </li>
    );
}

export function UsedMemories({ runId, ids }: { runId: string | null; ids: string[] }) {
    const { t } = useI18n();
    const [memories, setMemories] = useState<Memory[]>([]);

    useEffect(() => {
        let cancelled = false;
        void Promise.all(ids.map((id) => api.memory.get(id).catch(() => null))).then((found) => {
            if (!cancelled) setMemories(found.filter((m): m is Memory => m !== null));
        });
        return () => {
            cancelled = true;
        };
    }, [ids]);

    if (memories.length === 0) return null;
    return (
        <details className="card used-memories" data-testid="used-memories">
            <summary className="small">{t('feedback.title', { n: memories.length })}</summary>
            <ul className="list">
                {memories.map((m) => (
                    <UsedMemory key={m.id} memory={m} runId={runId} />
                ))}
            </ul>
        </details>
    );
}
