// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 浏览器里的 SDK 实例:同源 Cookie 会话,修改类请求从 aip_csrf Cookie 读 CSRF 令牌(ADR 0009 第 1 节)。
import { FatCatApiError, createClient } from '@fatcat-ai/client';

function readCookie(name: string): string | null {
    for (const part of document.cookie.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
}

export const api = createClient({ baseUrl: window.location.origin, csrfToken: () => readCookie('aip_csrf') });

/** 把任意错误变成一行可读文字(只用服务器的 detail / title,不包含请求头)。 */
export function errorText(error: unknown): string {
    if (error instanceof FatCatApiError) {
        const text = error.problem.detail ?? error.problem.title;
        const issue = error.problem.issues?.[0];
        return issue ? `${text} (${issue.path.join('.')}: ${issue.message})` : text;
    }
    return error instanceof Error ? error.message : String(error);
}
