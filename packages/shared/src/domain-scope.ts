// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 预授权里「允许的域名」的解析与匹配规则(ADR 0039)。纯函数,Web(输入时提示)、服务器(保存时校验)与
// 工具策略(运行时匹配)共用同一份,避免三处各写各的。

export type DomainScopeProblem = 'empty' | 'protocol' | 'path' | 'port' | 'broad' | 'invalid';

export type DomainScopeResult = { ok: string } | { problem: DomainScopeProblem };

/** 规范化并校验一个域名范围:`example.com`(只匹配它本身)或 `*.example.com`(只匹配子域)。 */
export function parseDomainScope(raw: string): DomainScopeResult {
    const value = raw.trim().toLowerCase();
    if (!value) return { problem: 'empty' };
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) return { problem: 'protocol' };
    if (/[/?#\\]/.test(value)) return { problem: 'path' };
    if (value.includes(':')) return { problem: 'port' };
    const host = value.replace(/\.$/, '');
    if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host) || host.length > 253) {
        return { problem: 'invalid' };
    }
    // *.com 之类等于放行整个顶级域;至少要有两段(*.example.com)
    if (host.startsWith('*.') && !host.slice(2).includes('.')) return { problem: 'broad' };
    return { ok: host };
}

/** 把输入框里的文字(逗号、分号或空白分隔)拆成多个域名范围;去重并保持顺序。 */
export function splitDomainScopes(raw: string): string[] {
    return [...new Set(raw.split(/[\s,;\uFF0C\uFF1B]+/).filter((part) => part.length > 0))];
}

/**
 * 域名匹配:`example.com` 只匹配它本身(不含 www.example.com 等子域);
 * `*.example.com` 匹配所有子域(含多级,如 a.b.example.com),**不**匹配 example.com 本身。
 */
export function matchesDomain(host: string, pattern: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, '');
    if (pattern.startsWith('*.')) return h.endsWith(pattern.slice(1));
    return h === pattern;
}

/** 填了裸域名(没有 www. 前缀、不是 *. 通配)时,返回建议补上的两个写法;否则返回 null。 */
export function bareDomainSuggestion(scope: string): { www: string; wildcard: string } | null {
    if (scope.startsWith('*.') || scope.startsWith('www.')) return null;
    if (!scope.includes('.')) return null;
    return { www: `www.${scope}`, wildcard: `*.${scope}` };
}
