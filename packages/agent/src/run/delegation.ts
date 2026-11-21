// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 委派(ADR 0042 第 3 节):delegate 工具的执行、子运行的循环,以及沿委派树共享的预算、深度与并发。
import type { Usage } from '@fatcat-ai/shared';
import { type ChatMessage, ProviderError, type ToolCall } from '@fatcat-ai/providers';
import { type DelegateRequest, type DelegateResult, ToolDeniedError } from '@fatcat-ai/tools';
import { type LoopCtx, problem, type ResolvedAgent, type RunHost, tokensOf } from './common.js';
import { systemMessage } from './context-builder.js';
import { isWithheld, runCalls } from './tool-step.js';

/** 每个运行内同时进行的委派数上限(ADR 0042 第 3 节)。 */
export const DEFAULT_DELEGATE_PARALLELISM = 3;

/** 一棵委派树共用的预算:先到先停;子预算同时计入所有祖先。 */
export class Budget {
    used = 0;
    constructor(
        readonly tokens: number | null,
        readonly deadline: number | null,
        readonly parent: Budget | null,
    ) {}
    charge(n: number): void {
        this.used += n;
        this.parent?.charge(n);
    }
    exhausted(now: number): boolean {
        if (this.tokens !== null && this.used >= this.tokens) return true;
        if (this.deadline !== null && now >= this.deadline) return true;
        return this.parent?.exhausted(now) ?? false;
    }
    /** 链上最早的截止时间。 */
    earliestDeadline(): number | null {
        const up = this.parent?.earliestDeadline() ?? null;
        if (this.deadline === null) return up;
        return up === null ? this.deadline : Math.min(up, this.deadline);
    }
}

/** 简单的并发闸:acquire 返回释放函数。 */
export class Limiter {
    private active = 0;
    private readonly waiting: (() => void)[] = [];
    constructor(private readonly limit: number) {}
    async acquire(): Promise<() => void> {
        if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
        else this.active++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = this.waiting.shift();
            if (next) next();
            else this.active--;
        };
    }
}

/** 子代理开头的提示:它看不到委派者的对话,答案只回给委派者。 */
const DELEGATED_NOTE =
    'Another agent handed you this task and cannot see your work. You do not see its conversation. ' +
    'Do the task with the tools you have, then finish with a clear final answer as plain text; ' +
    'your answer goes back to that agent, not to the user.';

/** 子代理返回给委派者的文本上限。 */
const MAX_DELEGATE_TEXT = 20_000;

/** 能再委派:代理设置了委派(resolveAgent)、深度未到上限、预算没用完。普通对话与定时任务没有代理,所以没有 delegate。 */
export function mayDelegate(host: RunHost, ctx: LoopCtx): boolean {
    return ctx.canDelegate && ctx.depth < ctx.maxDepth && !ctx.budget.exhausted(host.now());
}

/**
 * delegate 工具的执行(ADR 0042 第 3 节):子代理在自己的 run 行(parent_run_id)里用独立上下文运行,
 * 工具集 = 子代理的集合 ∩ 委派者的有效集合,审批、审计与越权判断走同一份 runToolCall,
 * 预算(token / 时间)沿委派树共享,先到先停。
 */
export async function delegate(host: RunHost, parent: LoopCtx, request: DelegateRequest): Promise<DelegateResult> {
    if (!mayDelegate(host, parent)) throw new ToolDeniedError('delegation limit reached (depth or budget)');
    const resolved = host.options.resolveAgent?.(parent.ownerId, request.agent);
    if (!resolved) throw new Error(`unknown agent: ${request.agent}`);
    const release = await parent.delegateSlots.acquire();
    try {
        return await runChild(host, parent, resolved, request);
    } finally {
        release();
    }
}

async function runChild(
    host: RunHost,
    parent: LoopCtx,
    { agent, profile: ownProfile }: ResolvedAgent,
    request: DelegateRequest,
): Promise<DelegateResult> {
    const { options } = host;
    const { repos } = options;
    const { ownerId, sessionId } = parent;
    const tools = options.tools;
    if (parent.signal.aborted) return { agent: agent.name, text: '', stopped: 'cancelled' };
    const budget = new Budget(
        agent.budgetTokens,
        agent.budgetSeconds ? host.now() + agent.budgetSeconds * 1000 : null,
        parent.budget,
    );
    if (budget.exhausted(host.now())) throw new ToolDeniedError('delegation budget exhausted');
    const childRun = repos.runs.create(ownerId, {
        sessionId,
        inputMessageId: parent.userMessageId,
        agentId: agent.id,
        parentRunId: parent.runId,
    });
    repos.runs.setStatus(childRun.id, 'running');

    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    parent.signal.addEventListener('abort', onParentAbort, { once: true });
    let timedOut = false;
    const deadline = budget.earliestDeadline();
    const timer =
        deadline === null
            ? null
            : setTimeout(
                  () => {
                      timedOut = true;
                      controller.abort();
                  },
                  Math.max(0, deadline - host.now()),
              );

    const ctx: LoopCtx = {
        ownerId,
        sessionId,
        runId: childRun.id,
        userMessageId: parent.userMessageId,
        assistantMessageId: parent.assistantMessageId,
        signal: controller.signal,
        emit: (event) => host.emit(ownerId, sessionId, childRun.id, event),
        persist: () => undefined,
        parts: [],
        locale: parent.locale,
        untrusted: parent.untrusted,
        toolSets: [...parent.toolSets, { set: agent.toolSet, label: 'agent' }],
        withheldPrefixes: parent.withheldPrefixes,
        noMemory: parent.noMemory || agent.memoryScope === 'none',
        initiator: agent.name,
        depth: parent.depth + 1,
        maxDepth: Math.min(parent.maxDepth, agent.maxDepth),
        budget,
        canDelegate: true,
        delegateSlots: new Limiter(options.delegateParallelism ?? DEFAULT_DELEGATE_PARALLELISM),
        profile: ownProfile ?? parent.profile,
    };

    const messages: ChatMessage[] = [];
    if (tools?.size) messages.push(systemMessage(host, ownerId));
    messages.push({ role: 'system', content: DELEGATED_NOTE });
    if (agent.prompt.trim()) messages.push({ role: 'system', content: agent.prompt.trim() });
    messages.push({
        role: 'user',
        content: request.context ? `${request.task}\n\nContext:\n${request.context}` : request.task,
    });

    let lastText = '';
    let total = 0;
    let stopped: DelegateResult['stopped'];
    try {
        const provider = options.providerFor(ctx.profile);
        for (let step = 0; ; step++) {
            if (ctx.signal.aborted) {
                stopped = timedOut ? 'budget' : 'cancelled';
                break;
            }
            if (budget.exhausted(host.now())) {
                stopped = 'budget';
                break;
            }
            const specs =
                tools && tools.size > 0 && step < agent.maxSteps
                    ? tools.specs(ctx.ownerId).filter((spec) => !isWithheld(host, ctx, spec.name))
                    : undefined;
            const calls: ToolCall[] = [];
            let stepText = '';
            let reason: string | null = null;
            let usage: Usage | undefined;
            for await (const chunk of provider.stream({
                messages,
                signal: ctx.signal,
                ...(specs ? { tools: specs } : {}),
            })) {
                if (chunk.type === 'text-delta') stepText += chunk.delta;
                else if (chunk.type === 'tool-call') {
                    calls.push({ callId: chunk.callId, name: chunk.name, input: chunk.input });
                } else {
                    reason = chunk.reason;
                    usage = chunk.usage;
                }
            }
            const used = tokensOf(usage);
            total += used;
            budget.charge(used);
            if (stepText.trim()) lastText = stepText;
            if (reason === 'aborted' || ctx.signal.aborted) {
                stopped = timedOut ? 'budget' : 'cancelled';
                break;
            }
            if (calls.length === 0 || !specs) break;
            messages.push({ role: 'assistant', content: stepText, toolCalls: calls });
            if (await runCalls(host, ctx, calls, messages)) {
                stopped = timedOut ? 'budget' : 'cancelled';
                break;
            }
        }
        repos.runs.setStatus(childRun.id, stopped === 'cancelled' ? 'cancelled' : 'succeeded');
    } catch (error) {
        if (ctx.signal.aborted && !(error instanceof ProviderError)) {
            repos.runs.setStatus(childRun.id, 'cancelled');
            return { agent: agent.name, text: lastText, stopped: timedOut ? 'budget' : 'cancelled' };
        }
        const message = error instanceof ProviderError ? error.message : 'the sub-agent failed unexpectedly';
        repos.runs.setStatus(childRun.id, 'failed', {
            error: problem(childRun.id, error instanceof ProviderError ? 502 : 500, 'provider_error', message),
        });
        if (!(error instanceof ProviderError)) options.onError?.(error, { runId: childRun.id });
        throw new Error(`sub-agent ${agent.name} failed: ${message}`, { cause: error });
    } finally {
        if (timer) clearTimeout(timer);
        parent.signal.removeEventListener('abort', onParentAbort);
    }
    const text = lastText.length > MAX_DELEGATE_TEXT ? `${lastText.slice(0, MAX_DELEGATE_TEXT)}…[truncated]` : lastText;
    return { agent: agent.name, text, ...(stopped ? { stopped } : {}), usage: { totalTokens: total } };
}
