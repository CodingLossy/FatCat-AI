// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ApprovalWarning, PreauthConstraintKind, ToolRisk } from '@ai-personal/shared';

/**
 * 工具在执行中发现请求越权(例如路径在授权目录之外)时抛出的错误:core 把这次调用按「拒绝」审计,
 * 即使工具是 read 级别(ADR 0010 第 6 节、ADR 0011)。
 */
export class ToolDeniedError extends Error {
    override readonly name: string = 'ToolDeniedError';
}

/** 工具执行时由 core 提供的上下文;其中的事实都来自 core,不来自模型。 */
export interface ToolContext {
    ownerId: string;
    sessionId: string;
    runId: string;
    userMessageId: string;
    assistantMessageId: string;
    /**
     * 本会话中是否已有工具返回过外部(不可信)内容(按会话判断,ADR 0016 第 7 节)。为 true 时条件预授权一律不成立,
     * 因为之后的调用可能是被这些内容诱导的(ADR 0010 第 4 节)。
     */
    untrustedContentSeen: boolean;
    /** 经审批后执行时:审批请求创建的时间。工具可据此确认审批之后内容没有被改动(例如 mail.send 的草稿)。 */
    approvalRequestedAt?: string;
}

/**
 * 工具定义(ADR 0010)。风险级别由工具作者或用户配置决定,从不由模型决定。
 * 输入来自模型:execute 必须自行校验,校验失败时抛错,错误信息会作为工具结果交还模型。
 */
export interface ToolDefinition {
    /** 内置工具如 fs.read;MCP 工具为 mcp.<server>.<tool>。 */
    name: string;
    description: string;
    /** 交给模型的 JSON Schema。 */
    parameters: Record<string, unknown>;
    risk: ToolRisk;
    /** 只能比级别默认值更严:'required' 让 read 工具也需审批(例如 web.fetch)。 */
    approval?: 'required';
    /** 为 false 时不允许预授权,每次都要审批(例如 memory.forget)。 */
    preauthorizable?: false;
    source?: 'builtin' | 'mcp';
    /** MCP 工具所属的服务器名。 */
    server?: string;
    /** 输出可能包含外部内容(网页、文件、MCP 输出);执行后本次运行的条件预授权失效。 */
    untrustedOutput?: boolean;
    /** 预授权支持的参数约束:从入参中取出规范化的值,取不出时返回 null(此时约束不匹配)。 */
    constraints?: Partial<Record<PreauthConstraintKind, (input: unknown, context: ToolContext) => string | null>>;
    /**
     * 保存预授权之前,把客户端传来的约束值规范化(例如路径先 realpath,ADR 0011 第 4 节);不合法时抛错。
     * 没有提供时按原样保存。
     */
    normalizeConstraint?: Partial<
        Record<PreauthConstraintKind, (value: string, context: { ownerId: string }) => string>
    >;
    /** 预授权时必须带这种约束(例如 web.fetch 只能按域名预授权,不能整体预授权)。 */
    requireConstraint?: PreauthConstraintKind;
    /** 条件预授权:只能依据 core 已知的事实计算(ADR 0010 第 4 节)。 */
    autoApproveWhen?: (input: unknown, context: ToolContext) => boolean;
    /**
     * 审批卡片上的说明;输入来自模型,调用方须按不可信的纯文本显示。
     * context 只在创建审批请求时提供(例如 mail.send 据此读出草稿的完整内容)。
     */
    summarize(input: unknown, context?: ToolContext): string;
    /** 创建审批请求时由 core 计算的警告(ADR 0016 第 8 节);只能依据 core 已知的事实。 */
    warnings?: (input: unknown, context: ToolContext) => ApprovalWarning[];
    execute(input: unknown, context: ToolContext): Promise<unknown>;
}
