// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 审批时「记住这个决定」的纯逻辑(ADR 0010 第 3 节),不依赖浏览器,便于单测。
import type { PreauthConstraint, ToolInfo, ToolRisk } from '@fatcat-ai/shared';

/** external / dangerous 工具不允许预授权(ADR 0010 第 3 节);风险未知时不提供「记住」。 */
export function canRemember(risk: ToolRisk | undefined): boolean {
    return risk === 'read' || risk === 'write';
}

/**
 * 「记住」时带的约束:工具支持按域名预授权时,取本次调用的域名(web.fetch 只能按域名预授权)。
 * 返回 null 表示这次不能记住(工具要求约束,但从入参中取不出)。
 */
export function rememberConstraint(info: ToolInfo | undefined, input: unknown): PreauthConstraint | null | undefined {
    if (!info) return undefined;
    if (info.constraints.includes('pathPrefix')) {
        // 文件工具按目录预授权:取目标所在的文件夹,服务器会 realpath 后再保存(ADR 0011 第 4 节)
        const args = input as { path?: unknown; to?: unknown } | null;
        const target = typeof args?.to === 'string' ? args.to : typeof args?.path === 'string' ? args.path : '';
        const folder = parentFolder(target);
        if (folder) return { pathPrefix: folder };
    }
    if (info.constraints.includes('domain')) {
        const url = (input as { url?: unknown } | null)?.url;
        try {
            const host = typeof url === 'string' ? new URL(url).hostname.toLowerCase() : '';
            if (host) return { domain: host };
        } catch {
            // 落到下面
        }
    }
    return info.requiredConstraint ? null : undefined;
}

/** 去掉最后一段得到所在文件夹(浏览器里没有 path 模块);没有上级时返回空串。 */
export function parentFolder(target: string): string {
    const trimmed = target.replace(/[\\/]+$/, '');
    const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    if (i < 0) return '';
    const folder = trimmed.slice(0, i);
    // C:\file.txt 的上级是 C:\;/file 的上级是 /
    if (folder === '' || /^[a-z]:$/i.test(folder)) return trimmed.slice(0, i + 1);
    return folder;
}
