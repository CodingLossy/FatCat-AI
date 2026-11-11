// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** 把一段文字渲染成二维码(SVG,本地生成,不请求任何外部服务)。 */
export function QrCode({ value, label, size = 200 }: { value: string; label: string; size?: number }) {
    const { count, path } = useMemo(() => {
        const qr = qrcode(0, 'M');
        qr.addData(value, 'Byte');
        qr.make();
        const n = qr.getModuleCount();
        let d = '';
        for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
        }
        return { count: n + 8, path: d };
    }, [value]);
    return (
        <svg
            role="img"
            aria-label={label}
            width={size}
            height={size}
            viewBox={`0 0 ${count} ${count}`}
            shapeRendering="crispEdges"
            className="qr-code"
        >
            <rect width={count} height={count} fill="#fff" />
            <path d={path} fill="#000" />
        </svg>
    );
}
