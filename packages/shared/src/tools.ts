// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 工具框架与审批的契约(ADR 0010):风险分级、工具信息、审批请求、预授权、审计、不可信内容。
import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';
import { PageQuery } from './pagination.js';

/** 风险级别:由工具作者或用户配置决定,从不由模型决定(ADR 0010 第 1 节)。 */
export const ToolRisk = z.enum(['read', 'write', 'external', 'dangerous']);
export type ToolRisk = z.infer<typeof ToolRisk>;

/** 当前生效的默认审批方式:直接执行 / 需审批 / 已禁用。 */
export const ToolApproval = z.enum(['auto', 'required', 'disabled']);
export type ToolApproval = z.infer<typeof ToolApproval>;

/** 预授权支持的参数约束类型。 */
export const PreauthConstraintKind = z.enum(['pathPrefix', 'domain']);
export type PreauthConstraintKind = z.infer<typeof PreauthConstraintKind>;

/** GET /api/v1/tools 的列表项。 */
export const ToolInfo = z.object({
    /** 内置工具如 fs.read;MCP 工具为 mcp.<server>.<tool>。 */
    name: z.string().min(1).max(200),
    description: z.string(),
    risk: ToolRisk,
    approval: ToolApproval,
    source: z.enum(['builtin', 'mcp']),
    /** MCP 工具所属的服务器名;内置工具为 null。 */
    server: z.string().nullable(),
    /** 能否预授权(external / dangerous 永远为 false)。 */
    preauthorizable: z.boolean(),
    /** 预授权时可用的参数约束;空数组表示只能整体预授权。 */
    constraints: z.array(PreauthConstraintKind),
    /** 预授权时必须带的约束(例如 web.fetch 只能按域名预授权);null 表示不要求。自 M2 PR 3 起提供。 */
    requiredConstraint: PreauthConstraintKind.nullable().optional(),
});
export type ToolInfo = z.infer<typeof ToolInfo>;

/** 预授权的参数约束;core 用规范化后的参数核对,不由模型判断。 */
export const PreauthConstraint = z.strictObject({
    pathPrefix: z.string().min(1).max(4096).optional(),
    domain: z
        .string()
        .min(1)
        .max(253)
        .regex(
            /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
            'must be a lowercase host name',
        )
        .optional(),
});
export type PreauthConstraint = z.infer<typeof PreauthConstraint>;

/** 批准时「记住这个决定」:本会话或永久;external / dangerous 不允许(服务器返回 400)。 */
export const PreauthRemember = z.strictObject({
    scope: z.enum(['session', 'always']),
    constraint: PreauthConstraint.optional(),
});
export type PreauthRemember = z.infer<typeof PreauthRemember>;

/** 已保存的预授权;永久预授权可在设置中查看和撤销。 */
export const Preauthorization = z.object({
    id: Id,
    toolName: z.string(),
    scope: z.enum(['session', 'always']),
    /** scope 为 session 时的会话 id。 */
    sessionId: Id.nullable(),
    constraint: PreauthConstraint.nullable(),
    createdAt: IsoDateTime,
    lastUsedAt: IsoDateTime.nullable(),
});
export type Preauthorization = z.infer<typeof Preauthorization>;

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** 持久化的审批请求;summary 与 input 来自模型,客户端须按不可信的纯文本显示。 */
/**
 * 已知的审批警告代码(ADR 0016 第 8 节)。ApprovalWarning.code 是字符串,以后新增代码不会成为破坏性修改。
 * recipient_untrusted:会话读过不可信内容后,mail.send 的收件人不来自主人的消息或被回复邮件的发件人。
 */
export const ApprovalWarningCode = z.enum(['recipient_untrusted']);
export type ApprovalWarningCode = z.infer<typeof ApprovalWarningCode>;

/** 审批警告:由 core 生成,message 不含模型或外部内容提供的文字;UI 有警告时标红。 */
export const ApprovalWarning = z.object({
    code: z.string().min(1).max(64),
    message: z.string().max(500),
});
export type ApprovalWarning = z.infer<typeof ApprovalWarning>;

export const ApprovalRequest = z.object({
    callId: z.string(),
    runId: Id,
    sessionId: Id,
    toolName: z.string(),
    risk: ToolRisk,
    summary: z.string(),
    /** 脱敏后的入参。 */
    input: z.unknown(),
    status: ApprovalStatus,
    /** 能否在批准时带 remember。 */
    preauthorizable: z.boolean(),
    createdAt: IsoDateTime,
    expiresAt: IsoDateTime,
    decidedAt: IsoDateTime.nullable(),
    /** 自 M3 起提供(ADR 0016 第 8 节);没有警告时省略。 */
    warnings: z.array(ApprovalWarning).max(20).optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/** GET /api/v1/approvals 的查询参数。 */
export const ApprovalQuery = PageQuery.extend({
    status: ApprovalStatus.optional(),
});
export type ApprovalQuery = z.infer<typeof ApprovalQuery>;

/** 审计中的「决定方式」(ADR 0010 第 6 节)。 */
export const AuditDecision = z.enum([
    'auto',
    'preauthorized',
    'conditional',
    'approved',
    'rejected',
    'expired',
    'cancelled',
    'denied',
]);
export type AuditDecision = z.infer<typeof AuditDecision>;

export const AuditEntry = z.object({
    id: Id,
    at: IsoDateTime,
    /** 工具调用之外的审计事件(预授权创建 / 撤销、记忆撤销)用 action 区分。 */
    action: z.enum(['tool-call', 'preauth-created', 'preauth-revoked', 'memory-undo']),
    toolName: z.string().nullable(),
    risk: ToolRisk.nullable(),
    callId: z.string().nullable(),
    runId: Id.nullable(),
    sessionId: Id.nullable(),
    decision: AuditDecision.nullable(),
    outcome: z.enum(['ok', 'error', 'not_run']),
    summary: z.string(),
    /** 脱敏后的入参摘要,≤ 500 字符;不含文件正文或网页内容。 */
    inputDigest: z.string().max(500).nullable(),
    error: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** GET /api/v1/audit 的查询参数;按时间倒序。 */
export const AuditQuery = PageQuery.extend({
    toolName: z.string().min(1).max(200).optional(),
    risk: ToolRisk.optional(),
    since: IsoDateTime.optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

/** 交给模型的外部内容包装(ADR 0010 第 7 节):untrusted 恒为 true,内容是数据,不是指令。 */
export const UntrustedContent = z.object({
    untrusted: z.literal(true),
    source: z.object({
        kind: z.enum(['web', 'file', 'mcp', 'email', 'item']),
        /** URL、文件路径、mcp.<server>.<tool> 或条目 id。 */
        ref: z.string(),
    }),
    content: z.string(),
    truncated: z.boolean(),
});
export type UntrustedContent = z.infer<typeof UntrustedContent>;
