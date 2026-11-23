// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 运行管理(ADR 0004、0010、0042):RunManager 的公开方法、运行生命周期和主循环。
// 上下文组装、单步工具调用、审批闸和委派分别在 run/ 下的模块里。
import type { AgentEvent, Message, MessagePart, PreauthRemember, Usage } from '@fatcat-ai/shared';
import { ProviderError, type ToolCall } from '@fatcat-ai/providers';
import type { ToolRegistry } from '@fatcat-ai/tools';
import { assistantLabel } from './labels.js';
import { resolveApproval } from './run/approval-gate.js';
import {
    type ApprovalVia,
    type Decision,
    type LoopCtx,
    problem,
    type Resolution,
    type RunHost,
    type RunManagerOptions,
    type StartedRun,
    type StartRunInput,
    tokensOf,
} from './run/common.js';
import { buildContext, memoryFor } from './run/context-builder.js';
import { Budget, DEFAULT_DELEGATE_PARALLELISM, Limiter } from './run/delegation.js';
import { isWithheld, runCalls } from './run/tool-step.js';
import type { ApprovalOutcome } from './tools.js';

export { DEFAULT_APPROVAL_TIMEOUT_MS } from './run/approval-gate.js';
export type {
    ApprovalVia,
    FinishedTurn,
    MemoryTurnContext,
    ResolvedAgent,
    RunAgent,
    RunManagerOptions,
    StartedRun,
    StartRunInput,
} from './run/common.js';
export { currentTimeLine, SYSTEM_PROMPT } from './run/context-builder.js';
export { DEFAULT_DELEGATE_PARALLELISM } from './run/delegation.js';

/** 一次运行中模型与工具来回的最大轮数,防止循环调用。 */
export const MAX_TOOL_STEPS = 5;

/** 同一会话同时只允许一个运行。 */
export class RunConflictError extends Error {
    override readonly name = 'RunConflictError';
    constructor(readonly activeRunId: string) {
        super('another run is active in this session');
    }
}

const TITLE_LENGTH = 40;

/**
 * 运行管理:运行与 HTTP 连接解耦,客户端断开不会中断运行,只有 cancel 会(ADR 0004 第 5 节)。
 * 每个事件先写入事件表(获得全局 seq),再经事件总线推送。
 */
export class RunManager {
    private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
    /** 正在等待审批的运行;审批状态本身以 approval_requests 表为准(ADR 0010 第 5 节)。 */
    private readonly approvals = new Map<string, { ownerId: string; resolve: (r: Resolution) => void }>();
    private readonly persistIntervalMs: number;
    private readonly now: () => number;
    /** 由定时任务发起的运行:runId → 任务信息(运行结束时移除)。 */
    private readonly taskRuns = new Map<string, NonNullable<StartRunInput['task']>>();
    /** run/ 下各模块经它访问选项与上面的内部状态。 */
    private readonly host: RunHost;

    /** 正在进行的运行数(维护任务据此推迟,ADR 0007 第 5.7 节)。 */
    get activeRuns(): number {
        return this.active.size;
    }

    constructor(private readonly options: RunManagerOptions) {
        this.persistIntervalMs = options.persistIntervalMs ?? 1000;
        this.now = options.now ?? Date.now;
        this.host = {
            options,
            now: () => this.now(),
            emit: (ownerId, sessionId, runId, event) => this.emit(ownerId, sessionId, runId, event),
            taskRuns: this.taskRuns,
            approvals: this.approvals,
        };
    }

    private emit(ownerId: string, sessionId: string, runId: string, event: AgentEvent): void {
        const envelope = this.options.repos.events.append(ownerId, { sessionId, runId, event });
        this.options.bus.publish(ownerId, envelope, runId);
    }

    /** 在一个事务中创建用户消息、运行与空的助手消息,然后在后台执行。 */
    start(input: StartRunInput): StartedRun {
        const { repos } = this.options;
        const created = repos.transaction(() => {
            const running = repos.runs.activeInSession(input.ownerId, input.sessionId);
            if (running) throw new RunConflictError(running.id);

            let userMessageId = input.inputMessageId;
            if (!userMessageId) {
                const user = repos.messages.append(input.ownerId, input.sessionId, {
                    role: 'user',
                    parts: [{ type: 'text', text: input.text ?? '' }, ...(input.images ?? [])],
                    status: 'complete',
                    clientMessageId: input.clientMessageId,
                });
                userMessageId = user.id;
                if (input.images?.length) {
                    repos.attachments.link(
                        input.ownerId,
                        input.images.map((i) => i.attachmentId),
                        user.id,
                    );
                }
                const session = repos.sessions.get(input.ownerId, input.sessionId);
                if (session && session.title === '' && input.text) {
                    repos.sessions.update(input.ownerId, input.sessionId, {
                        title: input.text.replace(/\s+/g, ' ').trim().slice(0, TITLE_LENGTH),
                    });
                }
            }
            const run = repos.runs.create(input.ownerId, {
                sessionId: input.sessionId,
                inputMessageId: userMessageId,
                ...(input.agent ? { agentId: input.agent.id } : {}),
            });
            const assistant = repos.messages.append(input.ownerId, input.sessionId, {
                role: 'assistant',
                parts: [],
                status: 'streaming',
                runId: run.id,
                parentMessageId: input.replacesMessageId ?? null,
                modelProfileId: input.profile.id,
            });
            repos.runs.setStatus(run.id, 'running', { outputMessageId: assistant.id });
            return { runId: run.id, userMessageId, assistantMessageId: assistant.id, assistantSeq: assistant.seq };
        });

        const controller = new AbortController();
        if (input.task) this.taskRuns.set(created.runId, input.task);
        const done = this.execute(input, created, controller.signal)
            .catch((error: unknown) => this.options.onError?.(error, { runId: created.runId }))
            .finally(() => {
                this.active.delete(created.runId);
                this.taskRuns.delete(created.runId);
            });
        this.active.set(created.runId, { controller, done });
        return {
            runId: created.runId,
            userMessageId: created.userMessageId,
            assistantMessageId: created.assistantMessageId,
        };
    }

    /** 中断运行;运行不存在或已结束时返回 false。 */
    cancel(runId: string): boolean {
        const entry = this.active.get(runId);
        if (!entry) return false;
        entry.controller.abort();
        return true;
    }

    /** 中断并等待运行完全结束(删除会话前调用,避免运行继续写已删除的行)。 */
    async stop(runId: string): Promise<void> {
        const entry = this.active.get(runId);
        if (!entry) return;
        entry.controller.abort();
        await entry.done;
    }

    /**
     * 处理审批。只有 pending 的请求能被决定,多端同时审批时只有第一个生效(条件更新,ADR 0010 第 5 节)。
     * remember 只能在批准时使用,external / dangerous 工具不允许预授权。
     * via:IM 渠道的审批(ADR 0022 第 6 节)走同一个函数,审计摘要末尾注明「via channel <id>」。
     */
    resolveApproval(
        ownerId: string,
        callId: string,
        decision: Decision,
        remember?: PreauthRemember,
        via?: ApprovalVia,
    ): ApprovalOutcome {
        return resolveApproval(this.host, ownerId, callId, decision, remember, via);
    }

    /** 注册的工具(GET /api/v1/tools 用)。 */
    get tools(): ToolRegistry | undefined {
        return this.options.tools;
    }

    isActive(runId: string): boolean {
        return this.active.has(runId);
    }

    /** 等待所有进行中的运行结束(测试与优雅退出用)。 */
    async idle(): Promise<void> {
        await Promise.all([...this.active.values()].map((e) => e.done));
    }

    /** 进程启动时:把上次异常退出遗留的运行标为失败,并补发终止事件,让客户端不会一直等待。 */
    recoverInterrupted(): number {
        const { repos } = this.options;
        const unfinished = repos.runs.listUnfinished();
        for (const run of unfinished) {
            const error = problem(run.id, 500, 'internal', 'The server restarted while this run was in progress.');
            repos.runs.setStatus(run.id, 'failed', { error });
            this.emit(run.ownerId, run.sessionId, run.id, { type: 'run-failed', runId: run.id, error });
        }
        repos.interruptStreamingMessages();
        // 重启后不恢复执行待审批的调用:模型调用的上下文已经不在内存中(ADR 0010 第 5 节)
        repos.approvals.expireAllPending();
        return unfinished.length;
    }

    private async execute(
        input: StartRunInput,
        run: StartedRun & { assistantSeq: number },
        signal: AbortSignal,
    ): Promise<void> {
        const { repos } = this.options;
        const { ownerId, sessionId } = input;
        const emit = (event: AgentEvent) => this.emit(ownerId, sessionId, run.runId, event);
        // 状态文字按界面语言生成(ADR 0021 第 7 节)
        const locale = repos.settings.get(ownerId).locale;
        const stateEvent = (state: 'thinking' | 'idle'): AgentEvent => ({
            type: 'assistant-state',
            state,
            label: assistantLabel(state, locale),
        });
        const tools = this.options.tools;
        // 按会话判断(ADR 0016 第 7 节):之前的轮次读过的外部内容仍在上下文里,同样算数
        const untrusted = { seen: repos.sessions.untrustedAt(sessionId) !== null };

        emit({
            type: 'run-started',
            runId: run.runId,
            sessionId,
            userMessageId: run.userMessageId,
            assistantMessageId: run.assistantMessageId,
        });
        emit(stateEvent('thinking'));

        // 助手消息的各部分:文本段、工具调用、工具结果,按发生顺序排列
        const parts: MessagePart[] = [];
        const appendText = (delta: string) => {
            const last = parts.at(-1);
            if (last?.type === 'text') last.text += delta;
            else parts.push({ type: 'text', text: delta });
        };
        let lastPersist = this.now();
        const persist = (status: Message['status'], usage?: Usage | null) =>
            repos.messages.update(run.assistantMessageId, {
                parts: structuredClone(parts),
                status,
                ...(usage !== undefined ? { usage } : {}),
            });
        const agent = input.agent;
        const ctx: LoopCtx = {
            ownerId,
            sessionId,
            runId: run.runId,
            userMessageId: run.userMessageId,
            assistantMessageId: run.assistantMessageId,
            signal,
            emit,
            persist: () => persist('streaming'),
            parts,
            locale,
            untrusted,
            ...(input.task ? { task: { id: input.task.id, channelId: input.task.channelId } } : {}),
            toolSets: [
                ...(input.task?.toolSet ? [{ set: input.task.toolSet, label: 'task' as const }] : []),
                ...(agent ? [{ set: agent.toolSet, label: 'agent' as const }] : []),
            ],
            withheldPrefixes: input.task?.withholdToolPrefixes ?? [],
            noMemory: agent?.memoryScope === 'none',
            depth: 0,
            maxDepth: agent?.maxDepth ?? 0,
            budget: new Budget(
                agent?.budgetTokens ?? null,
                agent?.budgetSeconds ? this.now() + agent.budgetSeconds * 1000 : null,
                null,
            ),
            canDelegate: Boolean(agent && this.options.resolveAgent),
            delegateSlots: new Limiter(this.options.delegateParallelism ?? DEFAULT_DELEGATE_PARALLELISM),
            profile: input.profile,
        };
        const finish = (reason: 'stop' | 'length' | 'cancelled', usage: Usage | undefined) => {
            persist(reason === 'cancelled' ? 'cancelled' : 'complete', usage ?? null);
            repos.runs.setStatus(run.runId, reason === 'cancelled' ? 'cancelled' : 'succeeded');
            emit({ type: 'run-finished', runId: run.runId, reason, ...(usage ? { usage } : {}) });
            // 记忆设置为 none 的代理不写记忆:自动抽取也不做(ADR 0042 第 4 节)
            if (reason === 'cancelled' || !this.options.onTurnFinished || input.agent?.memoryScope === 'none') return;
            try {
                this.options.onTurnFinished({
                    ownerId,
                    sessionId,
                    runId: run.runId,
                    userMessageId: run.userMessageId,
                    assistantMessageId: run.assistantMessageId,
                    untrustedContentSeen: untrusted.seen,
                });
            } catch (error) {
                this.options.onError?.(error, { runId: run.runId });
            }
        };

        try {
            const provider = this.options.providerFor(input.profile);
            const memory = await memoryFor(this.host, input, run, signal);
            // 有降级时即使没用到记忆也发,让客户端能说明「召回可能不完整」(ADR 0017 第 1 节)
            if (memory.ids.length > 0 || memory.degraded?.length) {
                emit({
                    type: 'memory-used',
                    runId: run.runId,
                    ids: memory.ids,
                    ...(memory.degraded?.length ? { degraded: memory.degraded } : {}),
                    ...(memory.omitted ? { omitted: memory.omitted } : {}),
                });
            }
            const messages = await buildContext(
                this.host,
                ownerId,
                sessionId,
                run.assistantSeq,
                input.profile,
                signal,
                memory.messages,
                input.agent?.prompt,
            );
            for (let step = 0; ; step++) {
                if (signal.aborted) return finish('cancelled', undefined);
                const calls: ToolCall[] = [];
                let stepText = '';
                let reason: string | null = null;
                let usage: Usage | undefined;
                const specs =
                    tools && tools.size > 0 && step < (agent?.maxSteps ?? MAX_TOOL_STEPS)
                        ? tools.specs(ctx.ownerId).filter((spec) => !isWithheld(this.host, ctx, spec.name))
                        : undefined;
                for await (const chunk of provider.stream({ messages, signal, ...(specs ? { tools: specs } : {}) })) {
                    if (chunk.type === 'text-delta') {
                        stepText += chunk.delta;
                        appendText(chunk.delta);
                        emit({ type: 'text-delta', runId: run.runId, delta: chunk.delta });
                        if (this.now() - lastPersist >= this.persistIntervalMs) {
                            persist('streaming');
                            lastPersist = this.now();
                        }
                    } else if (chunk.type === 'tool-call') {
                        calls.push({ callId: chunk.callId, name: chunk.name, input: chunk.input });
                    } else {
                        reason = chunk.reason;
                        usage = chunk.usage;
                    }
                }
                ctx.budget.charge(tokensOf(usage));
                if (reason === 'aborted' || signal.aborted) return finish('cancelled', usage);
                if (calls.length === 0 || !specs) {
                    // 整条回答没有任何内容(没有文字也没调用过工具)不算成功:否则任务页会显示「成功」却什么都没有
                    if (reason !== 'length' && parts.every((p) => p.type === 'text' && p.text.trim() === '')) {
                        throw new ProviderError('empty_response', 'the model returned an empty answer');
                    }
                    return finish(reason === 'length' ? 'length' : 'stop', usage);
                }

                messages.push({ role: 'assistant', content: stepText, toolCalls: calls });
                if (await runCalls(this.host, ctx, calls, messages)) return finish('cancelled', usage);
                persist('streaming');
                emit(stateEvent('thinking'));
            }
        } catch (error) {
            if (signal.aborted && !(error instanceof ProviderError)) return finish('cancelled', undefined);
            const failure =
                error instanceof ProviderError
                    ? problem(run.runId, 502, 'provider_error', error.message, error.code)
                    : problem(run.runId, 500, 'internal', 'The run failed unexpectedly.');
            persist('error');
            repos.runs.setStatus(run.runId, 'failed', { error: failure });
            emit({ type: 'run-failed', runId: run.runId, error: failure });
            if (!(error instanceof ProviderError)) throw error;
        } finally {
            emit(stateEvent('idle'));
        }
    }
}
