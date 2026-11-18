// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Memory } from '@fatcat-ai/shared';
import { MEMORY_COLORS, memoryLayout } from '@fatcat-ai/ui';
import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { useI18n } from './i18n.js';
import { MapView } from './MapView.js';

/** 记忆簇(ADR 0044 第 6 节):按类型分簇着色,亮度表示置信度与分层,红色描边表示冲突;点击定位到下面的记忆卡片。 */
export function MemoryMap({ memories }: { memories: Memory[] }) {
    const { t } = useI18n();
    const [selected, setSelected] = useState<string | null>(null);
    const [conflicted, setConflicted] = useState<ReadonlySet<string>>(new Set());

    useEffect(() => {
        let alive = true;
        api.memory
            .conflicts()
            .then((page) => {
                if (!alive) return;
                const ids = new Set<string>();
                for (const c of page.items) if (c.status === 'open') ids.add(c.a.id).add(c.b.id);
                setConflicted(ids);
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, [memories]);

    const layout = useMemo(() => memoryLayout(memories, conflicted), [memories, conflicted]);
    const chosen = memories.find((m) => m.id === selected);

    const locate = (id: string | null) => {
        setSelected(id);
        if (!id) return;
        const card = document.querySelector(`[data-memory-id="${id}"]`);
        card?.scrollIntoView?.({ block: 'center' });
    };

    return (
        <section className="card memory-map" data-testid="memory-map">
            <MapView layout={layout} selectedId={selected} onSelect={locate} label={t('memory.map.aria')} />
            <ul className="legend small">
                {layout.groups.map((g) => (
                    <li key={g.key}>
                        <span className="swatch" style={{ background: MEMORY_COLORS[g.key] ?? '#7a8699' }} />
                        {g.key} ({g.count})
                    </li>
                ))}
                <li>
                    <span className="swatch conflict" />
                    {t('memory.map.conflict')}
                </li>
            </ul>
            <p className="small muted">{t('memory.map.hint')}</p>
            {chosen ? (
                <p className="small" role="status">
                    {chosen.text}
                </p>
            ) : null}
        </section>
    );
}
