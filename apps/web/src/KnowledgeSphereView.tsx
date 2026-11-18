// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Item } from '@fatcat-ai/shared';
import { createKnowledgeSphere, type KnowledgeSphere, type SphereItem } from '@fatcat-ai/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from './i18n.js';
import { itemTitle } from './item-title.js';

/** 当前分类的子项画成粒子球(ADR 0044 第 5 节)。打开 = 下钻或查看内容,返回 = 上一层。 */
export function KnowledgeSphereView(props: {
    items: Item[];
    onOpen: (item: Item) => void;
    onBack: () => void;
    hasMore: boolean;
}) {
    const { t } = useI18n();
    const canvas = useRef<HTMLCanvasElement>(null);
    const holder = useRef<HTMLDivElement>(null);
    const sphere = useRef<KnowledgeSphere | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const latest = useRef(props);
    useEffect(() => {
        latest.current = props;
    });

    const sphereItems = useMemo<SphereItem[]>(
        () =>
            props.items.map((i) => ({
                id: i.id,
                label: itemTitle(i, t),
                weight: i.descendantCount,
                category: i.kind === 'category' || i.childCount > 0,
            })),
        [props.items, t],
    );

    useEffect(() => {
        const el = canvas.current;
        if (!el) return;
        const s = createKnowledgeSphere(el, {
            onSelect: setSelected,
            onOpen: (id) => {
                const item = latest.current.items.find((i) => i.id === id);
                if (item) latest.current.onOpen(item);
            },
            onBack: () => latest.current.onBack(),
        });
        sphere.current = s;
        const fit = () => s?.resize(Math.min(560, holder.current?.clientWidth ?? 400));
        fit();
        window.addEventListener('resize', fit);
        return () => {
            window.removeEventListener('resize', fit);
            s?.destroy();
            sphere.current = null;
        };
    }, []);

    useEffect(() => {
        sphere.current?.setItems(sphereItems);
    }, [sphereItems]);

    const chosen = props.items.find((i) => i.id === selected);
    return (
        <div className="sphere-view" ref={holder}>
            <canvas ref={canvas} className="sphere-canvas" role="application" aria-label={t('items.sphere.aria')} />
            <p className="small muted">{t('items.sphere.hint')}</p>
            {chosen ? (
                <p className="small" role="status">
                    {t('items.sphere.selected').replace('{name}', itemTitle(chosen, t))}
                </p>
            ) : null}
            {props.hasMore ? <p className="small muted">{t('items.sphere.more')}</p> : null}
        </div>
    );
}
