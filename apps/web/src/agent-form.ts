// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Agent, AgentInput } from '@fatcat-ai/shared';

/** 表单里的字符串形式;数字留空表示不设上限。 */
export interface AgentDraft {
    name: string;
    systemPrompt: string;
    toolSet: string;
    memoryScope: 'shared' | 'none';
    modelProfileId: string;
    maxDepth: string;
    maxSteps: string;
    budgetTokens: string;
    budgetSeconds: string;
}

export const emptyDraft = (): AgentDraft => ({
    name: '',
    systemPrompt: '',
    toolSet: '',
    memoryScope: 'shared',
    modelProfileId: '',
    maxDepth: '2',
    maxSteps: '5',
    budgetTokens: '',
    budgetSeconds: '',
});

export const draftOf = (agent: Agent): AgentDraft => ({
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    toolSet: agent.toolSet.join(', '),
    memoryScope: agent.memoryScope === 'none' ? 'none' : 'shared',
    modelProfileId: agent.modelProfileId ?? '',
    maxDepth: String(agent.maxDepth),
    maxSteps: String(agent.maxSteps),
    budgetTokens: agent.budgetTokens === null ? '' : String(agent.budgetTokens),
    budgetSeconds: agent.budgetSeconds === null ? '' : String(agent.budgetSeconds),
});

/** 逗号、空格或换行分隔;去重并保持顺序。 */
export function parseToolSet(text: string): string[] {
    return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/** 留空时用默认值,而不是 Number('') = 0。 */
const numberOr = (text: string, fallback: number): number => (text.trim() === '' ? fallback : Number(text));

const optionalNumber = (text: string): number | null => {
    const trimmed = text.trim();
    return trimmed === '' ? null : Number(trimmed);
};

/** 表单 → 请求体;数字不合法时让服务器的校验给出错误(不在这里重复一份规则)。 */
export function inputOf(draft: AgentDraft): AgentInput {
    return {
        name: draft.name.trim(),
        systemPrompt: draft.systemPrompt,
        modelProfileId: draft.modelProfileId === '' ? null : draft.modelProfileId,
        toolSet: parseToolSet(draft.toolSet),
        memoryScope: draft.memoryScope,
        maxDepth: numberOr(draft.maxDepth, 2),
        maxSteps: numberOr(draft.maxSteps, 5),
        budgetTokens: optionalNumber(draft.budgetTokens),
        budgetSeconds: optionalNumber(draft.budgetSeconds),
    };
}
