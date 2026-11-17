// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import {
    parseDomainScope,
    splitDomainScopes,
    type DomainScopeProblem,
    type TaskAllowedTool,
    type ToolInfo,
} from '@fatcat-ai/shared';

/** 可以在任务里预授权的工具:只读、默认需要审批、允许预授权(external / dangerous 永远不行)。 */
export function preauthCandidates(tools: ToolInfo[]): ToolInfo[] {
    return tools.filter((tool) => tool.risk === 'read' && tool.approval === 'required' && tool.preauthorizable);
}

export type ScopeProblem =
    { tool: string; kind: 'missing' } | { tool: string; kind: DomainScopeProblem; value: string };

/** 勾选状态 → 任务的白名单。需要范围的工具没填、或域名写法有明显错误时返回 problem。域名可以用逗号 / 空格填多个。 */
export function buildAllowedTools(
    tools: ToolInfo[],
    picked: Record<string, { on: boolean; scope: string }>,
): { allowed: TaskAllowedTool[]; problem: ScopeProblem | null } {
    const allowed: TaskAllowedTool[] = [];
    for (const tool of tools) {
        const entry = picked[tool.name];
        if (!entry?.on) continue;
        const kind = tool.requiredConstraint;
        if (kind === 'domain') {
            const parts = splitDomainScopes(entry.scope);
            if (parts.length === 0) return { allowed: [], problem: { tool: tool.name, kind: 'missing' } };
            for (const part of parts) {
                const parsed = parseDomainScope(part);
                if ('problem' in parsed) {
                    return { allowed: [], problem: { tool: tool.name, kind: parsed.problem, value: part } };
                }
                if (!allowed.some((a) => a.tool === tool.name && a.constraint?.domain === parsed.ok)) {
                    allowed.push({ tool: tool.name, constraint: { domain: parsed.ok } });
                }
            }
        } else if (kind) {
            const scope = entry.scope.trim();
            if (!scope) return { allowed: [], problem: { tool: tool.name, kind: 'missing' } };
            allowed.push({ tool: tool.name, constraint: { [kind]: scope } });
        } else allowed.push({ tool: tool.name });
    }
    return { allowed, problem: null };
}

/** 任务里已有的白名单 → 输入框初始文字:同一工具的多个域名合成一行。 */
export function initialScopes(initial: TaskAllowedTool[]): Record<string, { on: boolean; scope: string }> {
    const out: Record<string, { on: boolean; scope: string }> = {};
    for (const a of initial) {
        const part = a.constraint?.domain ?? a.constraint?.pathPrefix ?? '';
        const prev = out[a.tool];
        out[a.tool] = { on: true, scope: prev && part ? `${prev.scope}, ${part}` : (prev?.scope ?? part) };
    }
    return out;
}
