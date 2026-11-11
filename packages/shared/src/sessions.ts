// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';
import { ImageMessagePart, AttachmentIds } from './attachments.js';
import { Id, IsoDateTime, Usage } from './common.js';
import { PreauthRemember } from './tools.js';

export const MessageRole = z.enum(['user', 'assistant', 'system']);
export type MessageRole = z.infer<typeof MessageRole>;

export const MessageStatus = z.enum(['streaming', 'complete', 'error', 'cancelled']);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const MessagePart = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('tool-call'), callId: z.string(), name: z.string(), input: z.unknown() }),
    z.object({
        type: z.literal('tool-result'),
        callId: z.string(),
        output: z.unknown(),
        error: z.string().optional(),
    }),
    /** 用户上传的图片(ADR 0020 第 4 节),自 M4 起提供;客户端须忽略不认识的 part 类型。 */
    ImageMessagePart,
]);
export type MessagePart = z.infer<typeof MessagePart>;

export const Message = z.object({
    id: Id,
    sessionId: Id,
    /** 会话内从 1 开始连续递增。 */
    seq: z.number().int().positive(),
    role: MessageRole,
    parts: z.array(MessagePart),
    status: MessageStatus,
    runId: Id.nullable(),
    /** 重新生成 / 编辑形成的分支:指向被替代的那条消息(为会话地图预留,ADR 0007)。 */
    parentMessageId: Id.nullable(),
    modelProfileId: Id.nullable(),
    usage: Usage.nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
});
export type Message = z.infer<typeof Message>;

export const Session = z.object({
    id: Id,
    title: z.string().max(200),
    modelProfileId: Id.nullable(),
    forkedFromSessionId: Id.nullable(),
    forkedFromMessageId: Id.nullable(),
    lastMessageAt: IsoDateTime.nullable(),
    activeRunId: Id.nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
});
export type Session = z.infer<typeof Session>;

export const CreateSessionRequest = z.object({
    title: z.string().max(200).optional(),
    modelProfileId: Id.optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const UpdateSessionRequest = z.object({
    title: z.string().min(1).max(200).optional(),
    modelProfileId: Id.nullable().optional(),
});
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

export const SendMessageRequest = z.object({
    text: z.string().min(1).max(100_000),
    /** 覆盖会话默认的模型配置档。 */
    modelProfileId: Id.optional(),
    /** 随消息发送的图片附件,先经 POST /api/v1/attachments 上传(ADR 0020 第 4 节)。自 M4 起提供。 */
    attachmentIds: AttachmentIds.optional(),
    /** 幂等键:同一会话内重复提交相同值时返回已有运行(ADR 0004)。 */
    clientMessageId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,64}$/)
        .optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

/** `?stream=false` 时的响应。 */
export const SendMessageAccepted = z.object({
    runId: Id,
    userMessageId: Id,
    assistantMessageId: Id,
});
export type SendMessageAccepted = z.infer<typeof SendMessageAccepted>;

export const RunStatus = z.enum(['queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatus>;

export const Run = z.object({
    id: Id,
    sessionId: Id,
    status: RunStatus,
    inputMessageId: Id,
    outputMessageId: Id.nullable(),
    startedAt: IsoDateTime,
    finishedAt: IsoDateTime.nullable(),
});
export type Run = z.infer<typeof Run>;

export const ApprovalDecision = z.object({
    decision: z.enum(['approve', 'reject']),
    /** 批准时可选「记住这个决定」(ADR 0010 第 3 节);拒绝时不允许。 */
    remember: PreauthRemember.optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
