// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { useI18n } from '../i18n.js';
import { visibleText } from './sanitize.js';

export const MEMORY_READ_TOOLS = ['memory.retrieve', 'memory.search'];

interface Row {
    id: string;
    text: string;
    type?: string;
}

function rows(output: unknown): Row[] | null {
    const items = (output as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return null;
    return items.flatMap((m): Row[] => {
        const r = m as { id?: unknown; text?: unknown; type?: unknown } | null;
        if (!r || typeof r.id !== 'string' || typeof r.text !== 'string') return [];
        return [{ id: r.id, text: r.text, ...(typeof r.type === 'string' ? { type: r.type } : {}) }];
    });
}

/** 记忆检索结果卡:记忆文本加类型标签,按文本显示(撤销 / 保留走记忆页的现有接口)。 */
export function MemoryCard({ output }: { output: unknown }) {
    const { t } = useI18n();
    const list = rows(output);
    if (!list) return null;
    return (
        <div className="vis-card memory-card" data-testid="memory-card">
            <strong className="small">{t('vis.memory.found')}</strong>
            {list.length === 0 ? (
                <p className="small muted">{t('vis.memory.empty')}</p>
            ) : (
                <ul className="vis-list">
                    {list.slice(0, 50).map((m) => (
                        <li key={m.id}>
                            {m.type ? <span className="risk-tag">{visibleText(m.type)}</span> : null}{' '}
                            <span>{visibleText(m.text)}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
