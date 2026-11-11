// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 「本次用到的记忆」面板里的召回说明:召回不完整(ADR 0017 第 5 节)与因篇幅未展示的条数。
import type { MemoryDegradation } from '@fatcat-ai/shared';
import { useI18n } from './i18n.js';
import { navigate, routePath } from './router.js';

type RecallNote = { key: 'timeout' | 'error' | 'auth' | 'rejected' | 'unknown'; settings: boolean };

/**
 * 召回不完整时要显示的说明(ADR 0017 第 5 节)。只有 vector 这一路会降级;不认识的路径或原因按「原因未知」显示。
 * 同一个说明只出现一次。
 */
export function recallNotes(degraded: readonly MemoryDegradation[]): RecallNote[] {
    const notes = new Map<RecallNote['key'], RecallNote>();
    for (const d of degraded) {
        const known = d.path === 'vector' && ['timeout', 'error', 'auth', 'rejected'].includes(d.reason);
        const key = known ? d.reason : 'unknown';
        notes.set(key, { key, settings: key === 'auth' || key === 'rejected' });
    }
    return [...notes.values()];
}

/** 召回降级与因篇幅未展示条数的说明,显示在面板中,不折叠。 */
export function RecallNotes({ degraded, omitted }: { degraded: readonly MemoryDegradation[]; omitted: number }) {
    const { t } = useI18n();
    const notes = recallNotes(degraded);
    if (notes.length === 0 && omitted <= 0) return null;
    return (
        <div className="recall-notes" role="status" data-testid="recall-notes">
            {notes.map((note) => (
                <p key={note.key} className="small muted">
                    {t(`recall.degraded.${note.key}`)}
                    {note.settings ? (
                        <>
                            {' '}
                            <a
                                href={routePath({ name: 'settings' })}
                                onClick={(e) => {
                                    e.preventDefault();
                                    navigate({ name: 'settings' });
                                }}
                            >
                                {t('recall.openSettings')}
                            </a>
                        </>
                    ) : null}
                </p>
            ))}
            {omitted > 0 ? <p className="small muted">{t('recall.omitted', { n: omitted })}</p> : null}
        </div>
    );
}
