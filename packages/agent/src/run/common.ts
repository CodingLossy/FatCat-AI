// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 运行管理各模块共用的类型与小工具:RunManager 的选项与输入、一次运行(根或子)的 LoopCtx,
// 以及各模块通过 RunHost 访问 RunManager 的内部状态(不对外导出)。
import type {
    AgentEvent,
    ImageMessagePart,
    MemoryDegradation,
    MessagePart,
    ProblemDetails,
    Settings,
    Usage,
} from '@fatcat-ai/shared';
import type { PreauthConstraint } from '@fatcat-ai/shared';
import type { ModelProvider } from '@fatcat-ai/providers';
import type { ModelProfileRecord, Repositories } from '@fatcat-ai/storage';
import type { ToolRegistry } from '@fatcat-ai/tools';
import type { EventBus } from '../bus.js';
import type { ImageLoader } from '../context.js';
import type { Budget, Limiter } from './delegation.js';

/** 每轮的记忆上下文:系统消息、用到的记忆,以及召回是否完整(ADR 0017)。 */
export interface MemoryTurnContext {
    messages: string[];
    ids: string[];
    degraded?: MemoryDegradation[] | undefined;
    omitted?: number | undefined;
}

export interface RunManagerOptions {
    repos: Repositories;
    bus: EventBus;
    /** 为配置档创建 provider;测试中可替换为假实现。 */
    providerFor: (profile: ModelProfileRecord) => ModelProvider;
    /** 流式过程中把已生成的正文写回消息表的最小间隔,默认 1 秒。 */
    persistIntervalMs?: number;
    now?: () => number;
    onError?: (error: unknown, context: { runId: string }) => void;
    /** 读取图片附件(ADR 0020);未提供时上下文里的图片一律换成占位文本。 */
    loadImage?: (ownerId: string, attachmentId: string) => ReturnType<ImageLoader>;
    /** 交给模型的工具;为空时不发送 tools,也不加系统提示(ADR 0010)。 */
    tools?: ToolRegistry;
    /** 委派时按名称或 id 找子代理(ADR 0042 第 3 节);没有提供时 delegate 工具不可用。 */
    resolveAgent?: (ownerId: string, ref: string) => ResolvedAgent | null;
    /** 每个运行内同时进行的委派数,默认 3。 */
    delegateParallelism?: number;
    /** 审批请求的有效期,默认 30 分钟;过期按拒绝处理。 */
    approvalTimeoutMs?: number;
    /** 审批请求与审计中的入参脱敏(通常是 providers 的 Redactor);默认不做替换。 */
    redact?: (text: string) => string;
    /** 设置中「每次都要审批」:关闭条件预授权。 */
    disableConditional?: (ownerId: string) => boolean;
    /** 压缩旧消息的摘要函数(通常用 cheap 配置档);未提供或失败时直接丢弃最旧的消息。 */
    summarize?: (ownerId: string, transcript: string, signal: AbortSignal) => Promise<string>;
    /**
     * 一轮正常结束(未取消、未失败)后调用,例如自动抽取记忆。同步调用,耗时的工作应自行放到后台;
     * 抛出的错误交给 onError,不影响这一轮的结果。
     */
    onTurnFinished?: (turn: FinishedTurn) => void;
    /**
     * 每轮的记忆上下文(digest 与记忆块,ADR 0007 第 5.6 节):返回的系统消息放在系统提示之后,
     * 用到的记忆通过 memory-used 事件发出。失败时这一轮照常进行,只是没有记忆上下文。
     */
    /** 已安装且启用的 Skill(ADR 0048);没有提供时没有 Skill 目录,skill.use 也不交给模型。 */
    skills?: SkillSource;
    memoryContext?: (
        input: {
            ownerId: string;
            sessionId: string;
            query: string;
            firstTurn: boolean;
            contextWindow: number;
            /** 所属运行,只用于日志。 */
            runId: string;
        },
        signal: AbortSignal,
    ) => Promise<MemoryTurnContext>;
}

/** 一个已启用的 Skill(ADR 0048 第 1 节):全局 id、给模型看的一句话、工具集与来源。 */
export interface RunSkill {
    id: string;
    description: string;
    toolSet: string[];
    source: 'builtin' | 'plugin';
}

/** Skill 的来源:列出某个 owner 已启用的 Skill,并按需读取说明(运行时从已安装的包里读,不入库)。 */
export interface SkillSource {
    list(ownerId: string): RunSkill[];
    /** 说明的 markdown 原文;Skill 不存在、已停用或读不到时返回 null。 */
    instructions(ownerId: string, id: string): string | null;
}

export interface FinishedTurn {
    ownerId: string;
    sessionId: string;
    runId: string;
    userMessageId: string;
    assistantMessageId: string;
    /** 本轮是否有工具返回过外部(不可信)内容。 */
    untrustedContentSeen: boolean;
}

/** 运行用的代理(ADR 0042)。maxDepth / 预算只在代理能委派时有意义。 */
export interface RunAgent {
    id: string;
    name: string;
    prompt: string;
    toolSet: string[];
    memoryScope: 'shared' | 'own' | 'none';
    maxSteps: number;
    maxDepth: number;
    budgetTokens: number | null;
    budgetSeconds: number | null;
    /** 运行开始时自动 skill.use 的 Skill(ADR 0048 第 7 节);全局 id。 */
    skills?: string[];
}

/** 委派时按名称或 id 找到的子代理,以及它自己的模型配置档(没有则沿用委派者的)。 */
export interface ResolvedAgent {
    agent: RunAgent;
    profile: ModelProfileRecord | null;
}

export interface StartRunInput {
    ownerId: string;
    sessionId: string;
    profile: ModelProfileRecord;
    /** 新的用户消息;与 inputMessageId 二选一。 */
    text?: string;
    clientMessageId?: string | undefined;
    /** 随新用户消息发送的图片;附件在同一事务中挂到这条消息上(ADR 0020 第 4 节)。 */
    images?: ImageMessagePart[] | undefined;
    /** 重试 / 重新生成:沿用已有的用户消息。 */
    inputMessageId?: string;
    /** 重新生成时被替代的助手消息。 */
    replacesMessageId?: string;
    /**
     * 用某个代理运行(ADR 0042):prompt 是已按语言选好的人格提示词;toolSet 与任务的 toolSet 取交集(只缩小,
     * 集合外的工具既不交给模型、硬调用也按未知工具拒绝);memoryScope 为 none 时不召回记忆、也不交出 memory. 工具;
     * maxSteps 是这次运行的工具步数上限(默认等于 MAX_TOOL_STEPS)。
     */
    agent?: RunAgent;
    /**
     * 这次运行由定时任务发起(ADR 0034):allowedTools 是任务级预授权白名单(只对这一次运行生效,
     * 仍受 isPreauthorizable 限制:external / dangerous 工具永远要审批);channelId 是任务配置的输出渠道。
     */
    task?: {
        id: string;
        channelId?: string | undefined;
        allowedTools?: { tool: string; constraint?: PreauthConstraint }[];
        /** 不交给模型的工具名前缀(例如没有授权文件夹时的 `fs.`);模型硬调用也按未知工具处理。 */
        withholdToolPrefixes?: string[];
        /** 任务声明的工具集(ADR 0039 第 4 节):给出时只有集合内的工具交给模型,集合外的硬调用按未知工具处理;只缩小。 */
        toolSet?: string[];
    };
}

export interface StartedRun {
    runId: string;
    userMessageId: string;
    assistantMessageId: string;
}

export type Decision = 'approve' | 'reject';
/** 在哪里做的审批;IM 渠道里的审批在审计摘要里注明渠道(ADR 0022 第 6 节)。 */
export interface ApprovalVia {
    channelId: string;
}
export type Resolution = { decision: Decision; reason: 'user' | 'expired' | 'cancelled'; via?: ApprovalVia };

/** 一个运行(根运行或子运行)执行工具调用所需的一切。 */
export interface LoopCtx {
    ownerId: string;
    sessionId: string;
    runId: string;
    userMessageId: string;
    assistantMessageId: string;
    signal: AbortSignal;
    emit: (event: AgentEvent) => void;
    /** 把当前的助手消息写回(子运行没有自己的消息,什么也不做)。 */
    persist: () => void;
    parts: MessagePart[];
    locale: Settings['locale'];
    /** 本会话是否已读过外部内容;父子运行共用一个对象。 */
    untrusted: { seen: boolean };
    task?: { id: string; channelId?: string | undefined };
    /** 工具集链:一个工具必须在每一项里才可用(只缩小,ADR 0042 第 2 节)。 */
    toolSets: { set: string[]; label: 'task' | 'agent' }[];
    withheldPrefixes: string[];
    /** 本次运行用 tools.enable 开启的按需组(ADR 0047 第 1.3 节);不跨运行,不写库。 */
    activeGroups: Set<string>;
    /** 运行开始时取到的已启用 Skill(ADR 0048);子运行重新取,不继承父运行用过的 Skill。 */
    skills: RunSkill[];
    /** 本次运行已经 skill.use 过的 Skill;重复使用不再注入说明。 */
    usedSkills: Set<string>;
    /** 本次运行能用的 Skill(与工具集链的交集非空,最多 30 个):系统提示的 Skill 目录。 */
    catalog: RunSkill[];
    noMemory: boolean;
    /** 子运行里的代理名,出现在审批卡上;根运行为 undefined。 */
    initiator?: string;
    depth: number;
    maxDepth: number;
    budget: Budget;
    /** 能委派的运行才有:根运行的代理或子运行的代理本身。 */
    canDelegate: boolean;
    delegateSlots: Limiter;
    profile: ModelProfileRecord;
}

export type ToolOutcome = 'cancelled' | { output: unknown; error?: string };

/** 各模块经它读 RunManager 的选项与内部状态;由 RunManager 在构造时创建。 */
export interface RunHost {
    readonly options: RunManagerOptions;
    now(): number;
    emit(ownerId: string, sessionId: string, runId: string, event: AgentEvent): void;
    /** 由定时任务发起的运行:runId → 任务信息(运行结束时移除)。 */
    readonly taskRuns: Map<string, NonNullable<StartRunInput['task']>>;
    /** 正在等待审批的运行;审批状态本身以 approval_requests 表为准(ADR 0010 第 5 节)。 */
    readonly approvals: Map<string, { ownerId: string; resolve: (r: Resolution) => void }>;
}

export function redactOf(host: RunHost): (text: string) => string {
    return host.options.redact ?? ((text) => text);
}

export function tokensOf(usage: Usage | undefined): number {
    return usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

export function problem(
    runId: string,
    status: number,
    code: ProblemDetails['code'],
    detail: string,
    providerCode?: ProblemDetails['providerCode'],
): ProblemDetails {
    return {
        type: 'about:blank',
        title: status >= 500 && code !== 'provider_error' ? 'Internal Server Error' : 'Model request failed',
        status,
        code,
        detail,
        requestId: runId,
        ...(providerCode ? { providerCode } : {}),
    };
}
