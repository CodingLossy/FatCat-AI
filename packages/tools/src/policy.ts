// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 审批策略(ADR 0010 第 2–4 节):纯函数,不读数据库,便于单测与越权用例。
import type {
    PreauthConstraint,
    PreauthConstraintKind,
    Preauthorization,
    PreauthRemember,
    ToolApproval,
    ToolRisk,
} from '@fatcat-ai/shared';
import { isWithin } from './fs/paths.js';
import type { ToolContext, ToolDefinition } from './types.js';

export type PolicyDecision =
    | { action: 'deny'; reason: string }
    | { action: 'run'; decision: 'auto' | 'preauthorized' | 'conditional'; preauthId?: string }
    | { action: 'ask' };

export interface PolicyOptions {
    /** dangerous 级别的工具默认禁用。 */
    enableDangerous?: boolean | undefined;
    /** 设置中「每次都要审批」:关闭条件预授权。 */
    disableConditional?: boolean | undefined;
}

/** 永远不允许预授权的级别。 */
const NEVER_PREAUTHORIZED: readonly ToolRisk[] = ['external', 'dangerous'];

export function isEnabled(tool: ToolDefinition, options: PolicyOptions = {}): boolean {
    return tool.risk !== 'dangerous' || options.enableDangerous === true;
}

export function isPreauthorizable(tool: ToolDefinition): boolean {
    return !NEVER_PREAUTHORIZED.includes(tool.risk) && tool.preauthorizable !== false;
}

/** API 中显示的默认审批方式(不考虑预授权与条件)。 */
export function defaultApproval(tool: ToolDefinition, options: PolicyOptions = {}): ToolApproval {
    if (!isEnabled(tool, options)) return 'disabled';
    return tool.risk === 'read' && tool.approval !== 'required' ? 'auto' : 'required';
}

/** 路径前缀匹配:必须在分隔符边界上(/docs 不匹配 /docs-private);Windows 与 macOS 上不区分大小写。 */
function underPrefix(value: string, prefix: string): boolean {
    return isWithin(value, prefix);
}

/** 域名匹配:example.com 只匹配它本身;*.example.com 匹配所有子域,不匹配 example.com 本身。 */
function matchesDomain(host: string, pattern: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, '');
    if (pattern.startsWith('*.')) return h.endsWith(pattern.slice(1));
    return h === pattern;
}

function constraintMatches(
    tool: ToolDefinition,
    input: unknown,
    context: ToolContext,
    constraint: PreauthConstraint | null,
): boolean {
    if (!constraint) return true;
    for (const [kind, expected] of Object.entries(constraint) as [PreauthConstraintKind, string | undefined][]) {
        if (expected === undefined) continue;
        const actual = tool.constraints?.[kind]?.(input, context) ?? null;
        if (actual === null) return false;
        if (kind === 'pathPrefix' && !underPrefix(actual, expected)) return false;
        if (kind === 'domain' && !matchesDomain(actual, expected)) return false;
    }
    return true;
}

/**
 * 按 ADR 0010 第 2 节的顺序决定一次调用:禁用 → 预授权 → 条件预授权 → 级别默认值。
 * 工具声明的 approval: 'required' 只影响「默认值」那一步,预授权仍然可以生效(例如按域名预授权 web.fetch)。
 */
export function decide(
    tool: ToolDefinition,
    input: unknown,
    context: ToolContext,
    preauths: readonly Preauthorization[],
    options: PolicyOptions = {},
): PolicyDecision {
    if (!isEnabled(tool, options)) return { action: 'deny', reason: `the tool ${tool.name} is disabled` };

    if (isPreauthorizable(tool)) {
        const match = preauths.find(
            (p) =>
                p.toolName === tool.name &&
                (p.scope === 'always' || p.sessionId === context.sessionId) &&
                constraintMatches(tool, input, context, p.constraint),
        );
        if (match) return { action: 'run', decision: 'preauthorized', preauthId: match.id };

        if (
            tool.autoApproveWhen &&
            !options.disableConditional &&
            !context.untrustedContentSeen &&
            tool.autoApproveWhen(input, context)
        ) {
            return { action: 'run', decision: 'conditional' };
        }
    }

    return defaultApproval(tool, options) === 'auto' ? { action: 'run', decision: 'auto' } : { action: 'ask' };
}

/**
 * 保存预授权前规范化约束(ADR 0011 第 4 节);返回规范化后的 remember,或错误说明。
 * 先调用 checkRemember 做结构校验。
 */
export function prepareRemember(
    tool: ToolDefinition,
    remember: PreauthRemember,
    context: { ownerId: string },
): { ok: PreauthRemember } | { error: string } {
    const problem = checkRemember(tool, remember);
    if (problem) return { error: problem };
    if (!remember.constraint) return { ok: remember };
    const constraint: PreauthConstraint = {};
    for (const [kind, value] of Object.entries(remember.constraint) as [PreauthConstraintKind, string | undefined][]) {
        if (value === undefined) continue;
        const normalize = tool.normalizeConstraint?.[kind];
        try {
            constraint[kind] = normalize ? normalize(value, context) : value;
        } catch (error) {
            return { error: `invalid ${kind}: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
    return { ok: { ...remember, constraint } };
}

/** 校验批准时的 remember;返回错误说明,合法时返回 null(ADR 0010 第 3 节)。 */
export function checkRemember(tool: ToolDefinition, remember: PreauthRemember): string | null {
    if (!isPreauthorizable(tool)) {
        return tool.preauthorizable === false
            ? `the tool ${tool.name} needs approval every time`
            : `${tool.risk} tools cannot be pre-authorized`;
    }
    if (tool.requireConstraint && !remember.constraint?.[tool.requireConstraint]) {
        return `the tool ${tool.name} can only be pre-authorized with a ${tool.requireConstraint} constraint`;
    }
    for (const [kind, value] of Object.entries(remember.constraint ?? {})) {
        if (value === undefined) continue;
        if (!tool.constraints?.[kind as PreauthConstraintKind]) {
            return `the tool ${tool.name} does not support a ${kind} constraint`;
        }
    }
    return null;
}
