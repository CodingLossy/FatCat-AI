// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆的出处与生成来源(ADR 0007 第 5.9 节):每条出处若由模型抽取,显示那次运行的模型、状态与时间。
// 只显示元数据;出处摘录是用户自己的消息,按纯文本显示。
import type { MemorySource } from '@fatcat-ai/shared';
import { useI18n } from './i18n.js';

export function MemorySources({ sources }: { sources: readonly MemorySource[] }) {
    const { t, locale } = useI18n();
    if (sources.length === 0) {
        return (
            <p className="small muted" data-testid="memory-sources">
                {t('memory.sourcesEmpty')}
            </p>
        );
    }
    return (
        <ul className="small memory-sources" data-testid="memory-sources">
            {sources.map((s) => {
                const run = s.extractRun ?? null;
                return (
                    <li key={s.id} data-extract-run={run?.id ?? ''}>
                        {run ? (
                            <span>
                                {t('memory.extractRun', {
                                    model: run.model ?? '—',
                                    time: new Date(run.createdAt).toLocaleString(locale),
                                })}{' '}
                                ·{' '}
                                <span className={run.status === 'failed' ? 'error' : ''}>
                                    {run.status === 'failed'
                                        ? t('memory.extractRunFailed', { code: run.errorCode ?? '—' })
                                        : t('memory.extractRunSucceeded')}
                                </span>{' '}
                                · {t('memory.promptVersion', { v: run.promptVersion })}
                            </span>
                        ) : (
                            <span className="muted">
                                {t('memory.noExtractRun', { time: new Date(s.createdAt).toLocaleString(locale) })}
                            </span>
                        )}
                        {s.excerpt ? <div className="muted memory-excerpt">{s.excerpt}</div> : null}
                    </li>
                );
            })}
        </ul>
    );
}
