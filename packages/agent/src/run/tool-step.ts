// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 一步里的工具调用(ADR 0010、0042、0047):哪些工具交给模型(含按需工具组)、未知工具的原因、工具上下文、
// 每个调用的审批与执行、结果回填,以及不可信内容的标记。根运行与子运行共用同一份逻辑。
import { toolInSet } from '@fatcat-ai/shared';
import type { ChatMessage, ToolCall } from '@fatcat-ai/providers';
import { newId } from '@fatcat-ai/storage';
import {
    type DelegateRequest,
    isCoreGroup,
    type ToolContext,
    ToolDeniedError,
    type ToolGroupInfo,
} from '@fatcat-ai/tools';
import { assistantLabel } from '../labels.js';
import { auditCall, gate } from './approval-gate.js';
import type { LoopCtx, RunHost, ToolOutcome } from './common.js';
import { delegate, mayDelegate } from './delegation.js';
import { useSkill } from './skills.js';

/** 工具被任务 / 代理的设置排除的原因(括号里的部分);没被排除时为 undefined,只被前缀扣下时为 ''。 */
export function exclusion(host: RunHost, ctx: LoopCtx, name: string): string | undefined {
    // skill.use 属于运行控制(ADR 0048 第 6 节):不受工具集限制(Skill 自己与工具集取交集,只缩小,
    // 交集为空时由 skill.use 报出原因),但没有任何已启用的 Skill 时不交给模型。任务的 withholdToolPrefixes
    // 照样能扣下它(与其他工具一样按前缀);Skill 覆盖的工具被扣下时也不算进它的有效工具集。
    if (name === 'skill.use') {
        if (ctx.withheldPrefixes.some((prefix) => name.startsWith(prefix))) return '';
        return ctx.skills.length > 0 ? undefined : 'no skills are available here';
    }
    for (const { set, label } of ctx.toolSets) {
        if (!toolInSet(name, set)) return `not in this ${label}'s tool set`;
    }
    if (ctx.noMemory && name.startsWith('memory.')) return 'this agent does not use memory';
    if (name === 'delegate' && !mayDelegate(host, ctx)) return 'delegation is not available here';
    if (ctx.withheldPrefixes.some((prefix) => name.startsWith(prefix))) return '';
    return undefined;
}

/**
 * 按需工具组是否生效(ADR 0047 第 1.4 节):注册了 tools.enable、且本次运行没有任务或代理的工具集时才生效。
 * 有工具集时,工具集里点名的工具都视为已开启,已有的定时任务和代理行为不变;没有 tools.enable 时无法开启,也就不扣下。
 */
function groupsGated(host: RunHost, ctx: LoopCtx): boolean {
    return ctx.toolSets.length === 0 && host.options.tools?.get('tools.enable') !== undefined;
}

/** 工具所在的按需组还没开启时返回组名。 */
function closedGroup(host: RunHost, ctx: LoopCtx, name: string): string | undefined {
    const tools = host.options.tools;
    if (!tools || !groupsGated(host, ctx)) return undefined;
    const group = tools.groupOf(name);
    return isCoreGroup(group) || ctx.activeGroups.has(group) ? undefined : group;
}

export function isWithheld(host: RunHost, ctx: LoopCtx, name: string): boolean {
    return exclusion(host, ctx, name) !== undefined || closedGroup(host, ctx, name) !== undefined;
}

export function unknownToolReason(host: RunHost, ctx: LoopCtx, name: string): string {
    const why = exclusion(host, ctx, name);
    if (why) return `unknown tool: ${name} (${why})`;
    const group = why === undefined && host.options.tools?.get(name) ? closedGroup(host, ctx, name) : undefined;
    if (group) return `unknown tool: ${name} (enable group ${group} with tools.enable first)`;
    return `unknown tool: ${name}`;
}

/** 按需组目录(系统提示末尾一行):按需组生效时,本次运行能开启的组;否则为空。 */
export function optionalGroups(host: RunHost, ctx: LoopCtx): string[] {
    const tools = host.options.tools;
    if (!tools || !groupsGated(host, ctx)) return [];
    const groups = new Set<string>();
    for (const { name } of tools.specs(ctx.ownerId)) {
        const group = tools.groupOf(name);
        if (!isCoreGroup(group) && exclusion(host, ctx, name) === undefined) groups.add(group);
    }
    return [...groups].sort();
}

/** 说明的第一句,给 tools.enable 的结果用。 */
function firstSentence(text: string): string {
    const end = text.search(/\.(\s|$)/);
    return (end < 0 ? text : text.slice(0, end + 1)).slice(0, 200);
}

/**
 * tools.enable 的执行(ADR 0047 第 1.3 节):对本次运行开启一个组,返回组里可用的工具。
 * 组不存在、被工具集排除或在设置里关闭时报错;开启不改变组内任何工具的审批。
 */
export function enableGroup(host: RunHost, ctx: LoopCtx, group: string): ToolGroupInfo {
    const tools = host.options.tools;
    const inGroup = (name: string) => tools!.groupOf(name) === group;
    const registered = tools ? tools.specs().filter((spec) => inGroup(spec.name)) : [];
    if (registered.length === 0) throw new Error(`unknown tool group: ${group}`);
    const forOwner = tools!.specs(ctx.ownerId).filter((spec) => inGroup(spec.name));
    const available = forOwner.filter((spec) => exclusion(host, ctx, spec.name) === undefined);
    if (available.length === 0) {
        if (forOwner.length === 0) throw new Error(`tool group ${group} is turned off in settings`);
        const why = exclusion(host, ctx, forOwner[0]!.name);
        throw new Error(why ? `unknown tool group: ${group} (${why})` : `unknown tool group: ${group}`);
    }
    ctx.activeGroups.add(group);
    return {
        group,
        tools: available.map((spec) => ({ name: spec.name, description: firstSentence(spec.description) })),
    };
}

export function toolContextFor(host: RunHost, ctx: LoopCtx): ToolContext {
    return {
        ownerId: ctx.ownerId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        userMessageId: ctx.userMessageId,
        assistantMessageId: ctx.assistantMessageId,
        untrustedContentSeen: ctx.untrusted.seen,
        signal: ctx.signal,
        ...(ctx.task ? { task: ctx.task } : {}),
        ...(mayDelegate(host, ctx) ? { delegate: (request: DelegateRequest) => delegate(host, ctx, request) } : {}),
        enableGroup: (group: string) => enableGroup(host, ctx, group),
        useSkill: (id: string) => useSkill(host, ctx, id),
    };
}

/**
 * 执行一步里的所有工具调用并把结果回填给模型。同一步里的多个 delegate 并行执行(每个运行内最多
 * delegateParallelism 个),其他工具按顺序。返回 true 表示被取消。
 */
export async function runCalls(
    host: RunHost,
    ctx: LoopCtx,
    calls: ToolCall[],
    messages: ChatMessage[],
): Promise<boolean> {
    type Settled = { outcome: ToolOutcome } | { failure: unknown };
    const pending: Promise<Settled>[] = [];
    for (const call of calls) {
        const running: Promise<Settled> = runToolCall(host, ctx, call).then(
            (outcome) => ({ outcome }),
            (failure: unknown) => ({ failure }),
        );
        pending.push(call.name === 'delegate' ? running : Promise.resolve(await running));
    }
    const settled = await Promise.all(pending);
    let cancelled = false;
    settled.forEach((result, i) => {
        if ('failure' in result) throw result.failure;
        if (result.outcome === 'cancelled') {
            cancelled = true;
            return;
        }
        const { output, error } = result.outcome;
        messages.push({
            role: 'tool',
            toolCallId: calls[i]!.callId,
            content: JSON.stringify(error === undefined ? output : { error }),
        });
    });
    return cancelled;
}

/** 一次工具调用:校验、审批、执行、审计;根运行与子运行用同一份逻辑,审批与越权规则不因委派而放宽。 */
async function runToolCall(host: RunHost, ctx: LoopCtx, call: ToolCall): Promise<ToolOutcome> {
    const { repos } = host.options;
    const tools = host.options.tools;
    const { ownerId, sessionId } = ctx;
    // 对外的 callId 由服务器生成,保证全局唯一;模型侧的 id 只用于回填工具结果
    const callId = newId();
    const tool = isWithheld(host, ctx, call.name) ? undefined : tools?.get(call.name);
    ctx.emit({ type: 'tool-call', runId: ctx.runId, callId, name: call.name, input: call.input });
    ctx.parts.push({ type: 'tool-call', callId, name: call.name, input: call.input });

    let output: unknown = null;
    let error: string | undefined;
    if (!tool) {
        error = unknownToolReason(host, ctx, call.name);
        auditCall(host, ownerId, sessionId, ctx.runId, callId, call, null, 'denied', 'not_run', error);
    } else {
        const verdict = await gate(host, ctx, tool, call, callId, () => toolContextFor(host, ctx));
        if (verdict === 'cancelled') return 'cancelled';
        let { auditDecision, approved } = verdict;
        const { approvalRequestedAt, approvalVia } = verdict;
        error = verdict.error;
        if (approved) {
            ctx.emit({
                type: 'assistant-state',
                state: 'executing',
                toolName: tool.name,
                label: assistantLabel('executing', ctx.locale, tool),
            });
            try {
                output = await tool.execute(call.input, {
                    ...toolContextFor(host, ctx),
                    ...(approvalRequestedAt ? { approvalRequestedAt } : {}),
                });
            } catch (e) {
                error = e instanceof Error ? e.message : String(e);
                // 工具判定越权(如路径在授权目录外):按拒绝审计,read 工具也一样
                if (e instanceof ToolDeniedError) {
                    auditDecision = 'denied';
                    approved = false;
                }
            }
            if (tool.untrustedOutput && !ctx.untrusted.seen) {
                ctx.untrusted.seen = true;
                repos.sessions.markUntrusted(sessionId);
            }
        }
        // read 工具的普通调用不审计;经过审批流程或被拒绝的调用都审计(ADR 0010 第 6 节)
        if (tool.risk !== 'read' || auditDecision !== 'auto') {
            const outcome = !approved ? 'not_run' : error === undefined ? 'ok' : 'error';
            auditCall(
                host,
                ownerId,
                sessionId,
                ctx.runId,
                callId,
                call,
                tool,
                auditDecision,
                outcome,
                error,
                approvalVia,
            );
        }
    }
    const result = error === undefined ? {} : { error };
    ctx.emit({ type: 'tool-result', runId: ctx.runId, callId, output, ...result });
    ctx.parts.push({ type: 'tool-result', callId, output, ...result });
    return error === undefined ? { output } : { output, error };
}
