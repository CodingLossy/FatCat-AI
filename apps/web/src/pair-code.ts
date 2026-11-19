// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { PairingCode } from '@fatcat-ai/shared';

/**
 * 读出地址里的 ?code=,并立刻把它从地址栏和历史记录里去掉(配对码不留在浏览器历史里)。
 * 只返回格式合法的配对码。
 */
export function takePairingCode(search: string, replaceUrl: (url: string) => void): string {
    const raw = new URLSearchParams(search).get('code') ?? '';
    if (search) replaceUrl('/pair');
    const parsed = PairingCode.safeParse(raw);
    return parsed.success ? parsed.data : '';
}
