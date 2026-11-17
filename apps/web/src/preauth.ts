// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { TaskAllowedTool, ToolInfo } from '@fatcat-ai/shared';

/** 可以在任务里预授权的工具:只读、默认需要审批、允许预授权(external / dangerous 永远不行)。 */
export function preauthCandidates(tools: ToolInfo[]): ToolInfo[] {
    return tools.filter((tool) => tool.risk === 'read' && tool.approval === 'required' && tool.preauthorizable);
}

/** 勾选状态 → 任务的白名单。需要范围(域名 / 路径前缀)的工具没填范围时返回 missing。 */
export function buildAllowedTools(
    tools: ToolInfo[],
    picked: Record<string, { on: boolean; scope: string }>,
): { allowed: TaskAllowedTool[]; missing: string | null } {
    const allowed: TaskAllowedTool[] = [];
    for (const tool of tools) {
        const entry = picked[tool.name];
        if (!entry?.on) continue;
        const kind = tool.requiredConstraint;
        if (kind) {
            const scope = entry.scope.trim().toLowerCase();
            if (!scope) return { allowed: [], missing: tool.name };
            allowed.push({ tool: tool.name, constraint: { [kind]: kind === 'domain' ? scope : entry.scope.trim() } });
        } else allowed.push({ tool: tool.name });
    }
    return { allowed, missing: null };
}
