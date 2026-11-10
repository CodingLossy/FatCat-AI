// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { MetaResponse } from '@fatcat-ai/shared';

/** 页脚:展示许可证与源码链接(AGPL §13)。源码地址来自服务器 /api/v1/meta。 */
export function Footer({ meta }: { meta: MetaResponse | null }) {
    return (
        <footer className="footer">
            <span>FatCat-AI {meta ? `v${meta.serverVersion}` : ''}</span>
            <span> · </span>
            <span>{meta?.license ?? 'AGPL-3.0-only'}</span>
            {meta?.sourceUrl ? (
                <>
                    <span> · </span>
                    <a href={meta.sourceUrl} rel="noreferrer" target="_blank">
                        源代码 / Source
                    </a>
                </>
            ) : null}
        </footer>
    );
}
