// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createMapCanvas, type MapCanvas, type MapLayout } from '@fatcat-ai/ui';
import { useEffect, useRef } from 'react';

/** 记忆簇 / 会话地图共用的 2D 画布:点击选中,双击或 Enter 打开,方向键切换。 */
export function MapView(props: {
    layout: Pick<MapLayout, 'nodes' | 'edges'>;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onOpen?: (id: string) => void;
    label: string;
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const holder = useRef<HTMLDivElement>(null);
    const map = useRef<MapCanvas | null>(null);
    const handlers = useRef(props);
    useEffect(() => {
        handlers.current = props;
    });

    useEffect(() => {
        const el = canvas.current;
        if (!el) return;
        const m = createMapCanvas(el, {
            onSelect: (id) => handlers.current.onSelect(id),
            onOpen: (id) => handlers.current.onOpen?.(id),
        });
        map.current = m;
        const fit = () => m?.resize(Math.min(640, holder.current?.clientWidth ?? 400));
        fit();
        window.addEventListener('resize', fit);
        return () => {
            window.removeEventListener('resize', fit);
            m?.destroy();
            map.current = null;
        };
    }, []);
    useEffect(() => {
        map.current?.setLayout(props.layout);
    }, [props.layout]);
    useEffect(() => {
        map.current?.setSelected(props.selectedId);
    }, [props.selectedId]);

    return (
        <div className="map-view" ref={holder}>
            <canvas ref={canvas} className="map-canvas" role="application" aria-label={props.label} />
        </div>
    );
}
