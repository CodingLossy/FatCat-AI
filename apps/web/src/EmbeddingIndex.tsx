// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { EmbeddingStatus } from '@ai-personal/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';

/** 设置页中的向量索引(ADR 0014):显示 embed 配置档与队列状态;换了模型或维度时提示手动重建。 */
export function EmbeddingIndex() {
    const { t } = useI18n();
    const [status, setStatus] = useState<EmbeddingStatus | null>(null);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(
        () =>
            api.embeddings
                .status()
                .then(setStatus)
                .catch((e: unknown) => setError(errorText(e))),
        [],
    );

    useEffect(() => {
        void reload();
    }, [reload]);

    const rebuild = async () => {
        if (!window.confirm(t('embed.rebuildConfirm'))) return;
        setError(null);
        try {
            await api.embeddings.rebuild();
        } catch (err) {
            setError(errorText(err));
        }
        await reload();
    };

    if (!status) return error ? <p className="error">{error}</p> : null;
    return (
        <section data-embedding-state={status.state}>
            <h2>{t('embed.title')}</h2>
            {error ? <p className="error">{error}</p> : null}
            {status.state === 'disabled' ? (
                <p className="muted small">{t('embed.disabled')}</p>
            ) : (
                <p className="small">
                    {t('embed.summary', {
                        model: status.model ?? '',
                        dims: status.dimensions ?? '—',
                        embedded: status.embedded,
                        queued: status.queued,
                        today: status.today,
                        limit: status.dailyLimit,
                    })}
                </p>
            )}
            {status.failed > 0 ? <p className="small error">{t('embed.failed', { n: status.failed })}</p> : null}
            {status.lastError ? <p className="small muted">{status.lastError}</p> : null}
            {status.state === 'rebuild-required' ? (
                <div className="card row spread">
                    <span>{t('embed.rebuildHint', { old: status.indexModel ?? '', model: status.model ?? '' })}</span>
                    <button type="button" className="primary" onClick={() => void rebuild()}>
                        {t('embed.rebuild')}
                    </button>
                </div>
            ) : null}
        </section>
    );
}
