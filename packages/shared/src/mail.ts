// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 邮件契约(ADR 0016,M3 PR 1)。全部是新增类型;REST 路径与工具 schema 随 M3 PR 2、PR 3 增加。
import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';

/**
 * 邮箱密码 / 授权码的引用:env:NAME 或 file:NAME,与模型配置档的 apiKeyRef 规则相同(ADR 0006 第 2 节)。
 * 邮箱一定需要密码,所以不能为 null;API 与 Web UI 不接收明文密码(ADR 0016 第 1 节)。
 */
export const MailSecretRef = z
    .string()
    .regex(/^(env|file):[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'must be env:NAME or file:NAME');
export type MailSecretRef = z.infer<typeof MailSecretRef>;

/** 加密方式:tls 为直连 TLS(IMAP 993 / SMTP 465),starttls 为先明文再升级(SMTP 587);不支持不加密。 */
export const MailSecurity = z.enum(['tls', 'starttls']);
export type MailSecurity = z.infer<typeof MailSecurity>;

/** 主机名:不含协议、路径、空白或凭据(user@host)。 */
const Host = z
    .string()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/, 'must be a host name or a bracketed IPv6 address');

export const MailServer = z.strictObject({
    host: Host,
    port: z.number().int().min(1).max(65_535),
    security: MailSecurity,
});
export type MailServer = z.infer<typeof MailServer>;

/** 邮箱地址:宽松校验(各家邮箱的地址规则不同),只排除明显不合法的值。 */
export const MailAddressString = z
    .string()
    .trim()
    .min(3)
    .max(320)
    .regex(/^[^\s@<>()",;]+@[^\s@<>()",;]+$/, 'must be an e-mail address');

export const MailAddress = z.object({
    /** 显示名;来自邮件头,是不可信文本。 */
    name: z.string().max(200).nullable(),
    address: MailAddressString,
});
export type MailAddress = z.infer<typeof MailAddress>;

/**
 * 发送后在服务器「已发送」中留存副本的策略(ADR 0016 第 14 节)。
 * - `auto`:IMAP 主机已知会自动保存经 SMTP 发出的邮件(163、Gmail)时不 APPEND,其他主机 APPEND;
 * - `append`:总是由 AI-Personal APPEND 一份;
 * - `off`:从不 APPEND。
 * 服务器自己保存的那一份不经过 AI-Personal,AI-Personal 也不核实它是否存在。
 */
export const MailSentCopy = z
    .enum(['auto', 'append', 'off'])
    .describe(
        'Sent copy policy (ADR 0016 §14). auto: no APPEND on imap.163.com / imap.gmail.com, which save mail sent over SMTP themselves; APPEND on every other host. append: always APPEND. off: never APPEND. A copy the server saves by itself is not checked.',
    );
export type MailSentCopy = z.infer<typeof MailSentCopy>;

/** 未知字段一律拒绝,避免客户端误把明文密码放进其他字段后被静默丢弃(与 ModelProfileInput 一致)。 */
const MailAccountFields = z.strictObject({
    label: z.string().trim().min(1).max(60),
    /** 发件地址。 */
    address: MailAddressString,
    /** 登录用户名;多数邮箱就是完整地址。 */
    username: z.string().min(1).max(320),
    passwordRef: MailSecretRef,
    imap: MailServer,
    smtp: MailServer,
    /** 首次同步只拉最近 N 天(ADR 0016 第 2 节,默认 30)。 */
    initialSyncDays: z.number().int().min(1).max(365).default(30),
    /** 定时拉取的间隔(分钟,默认 5)。 */
    syncIntervalMinutes: z.number().int().min(5).max(1440).default(5),
    /**
     * 显式指定发送后是否由 AI-Personal APPEND 一份到「已发送」(true = `sentCopy: 'append'`,false = `'off'`)。
     * 不给且不给 `sentCopy` 时为 `'auto'`。两者都给时以 `sentCopy` 为准。ADR 0016 第 6、14 节。
     */
    appendToSent: z
        .boolean()
        .optional()
        .describe(
            'Explicit switch: true = sentCopy append, false = sentCopy off. If neither this nor sentCopy is given, a new account gets auto. sentCopy wins if both are given.',
        ),
    /** 发送后「已发送」副本的策略;不给时为 `'auto'`(ADR 0016 第 14 节)。 */
    sentCopy: MailSentCopy.optional(),
    enabled: z.boolean().default(true),
});

export const MailAccountInput = MailAccountFields;
export type MailAccountInput = z.input<typeof MailAccountInput>;

/** PATCH:字段均可选,不带默认值(没给的字段保持不变)。 */
export const MailAccountPatch = z.strictObject({
    label: MailAccountFields.shape.label.optional(),
    address: MailAddressString.optional(),
    username: MailAccountFields.shape.username.optional(),
    passwordRef: MailSecretRef.optional(),
    imap: MailServer.optional(),
    smtp: MailServer.optional(),
    initialSyncDays: z.number().int().min(1).max(365).optional(),
    syncIntervalMinutes: z.number().int().min(5).max(1440).optional(),
    appendToSent: z
        .boolean()
        .optional()
        .describe(
            'Explicit switch: true = sentCopy append, false = sentCopy off. Omit both to keep the current policy.',
        ),
    sentCopy: MailSentCopy.optional(),
    enabled: z.boolean().optional(),
});
export type MailAccountPatch = z.infer<typeof MailAccountPatch>;

export const MailPasswordStatus = z.enum(['present', 'missing']);

/** 账户响应:只返回密码引用与是否读得到,从不返回密码本身。 */
export const MailAccount = MailAccountFields.extend({
    id: Id,
    passwordStatus: MailPasswordStatus,
    /** 账户保存的策略:`auto`(按服务器决定)、`append`(总是 APPEND)或 `off`(从不 APPEND)。 */
    sentCopy: MailSentCopy,
    /** 按当前策略与 IMAP 主机,发送成功后 AI-Personal 是否会 APPEND 一份(只读的计算结果)。 */
    appendToSent: z
        .boolean()
        .describe(
            'Read only: whether AI-Personal will APPEND a copy to Sent after sending, computed from sentCopy and the IMAP host.',
        ),
    /** 最近一次同步的时间与错误摘要(人能看懂、已脱敏)。 */
    lastSyncedAt: IsoDateTime.nullable(),
    lastError: z.string().max(500).nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
});
export type MailAccount = z.infer<typeof MailAccount>;

export const MailFolder = z.object({
    id: Id,
    accountId: Id,
    /** 服务器上的文件夹路径,如 INBOX、Sent。 */
    path: z.string().min(1).max(1000),
    /** 显示名。 */
    name: z.string(),
    /** IMAP 特殊用途(\\Inbox、\\Sent 等,去掉反斜杠后小写),没有时为 null。 */
    specialUse: z.enum(['inbox', 'sent', 'drafts', 'junk', 'trash', 'archive', 'all', 'flagged']).nullable(),
    /** UIDVALIDITY 变化时重建该文件夹的缓存(ADR 0016 第 2 节)。 */
    uidValidity: z.number().int().nonnegative().nullable(),
    /** 已同步的最大 UID。 */
    lastUid: z.number().int().nonnegative(),
    /** 服务器支持 CONDSTORE 时记录的 HIGHESTMODSEQ,用于只取变化的 FLAGS;不支持时为 null(ADR 0016 第 2 节)。 */
    highestModseq: z
        .string()
        .regex(/^\d{1,20}$/)
        .nullable(),
    messageCount: z.number().int().nonnegative(),
    unreadCount: z.number().int().nonnegative(),
    lastSyncedAt: IsoDateTime.nullable(),
});
export type MailFolder = z.infer<typeof MailFolder>;

/** 附件只有索引;内容只在用户要求时下载(ADR 0016 第 3 节)。 */
export const MailAttachment = z.object({
    id: Id,
    filename: z.string().max(500),
    contentType: z.string().max(200),
    size: z.number().int().nonnegative(),
    /** 是否已经下载到本地(例如加入了知识库)。 */
    downloaded: z.boolean(),
});
export type MailAttachment = z.infer<typeof MailAttachment>;

export const MailMessage = z.object({
    id: Id,
    accountId: Id,
    folderId: Id,
    uid: z.number().int().nonnegative(),
    /** Message-ID 头(去掉尖括号);没有时为 null。 */
    messageId: z.string().max(1000).nullable(),
    inReplyTo: z.string().max(1000).nullable(),
    references: z.array(z.string().max(1000)).max(500),
    /** 会话串的键,由服务器计算(ADR 0016 第 4 节)。 */
    threadKey: z.string().min(1).max(200),
    from: MailAddress.nullable(),
    to: z.array(MailAddress),
    cc: z.array(MailAddress),
    subject: z.string().max(2000),
    /** 邮件头中的日期;解析不了时取收到的时间。 */
    date: IsoDateTime,
    /** 与服务器的 \Seen 同步;读取用 BODY.PEEK,不会把服务器上的邮件标为已读(ADR 0016 第 2 节)。 */
    unread: z.boolean(),
    /** 纯文本正文(HTML 转纯文本);列表接口中可以省略。 */
    text: z.string().optional(),
    /** 正文的前 200 字,供列表显示。 */
    snippet: z.string().max(200),
    attachments: z.array(MailAttachment),
});
export type MailMessage = z.infer<typeof MailMessage>;

export const MailThread = z.object({
    threadKey: z.string().min(1).max(200),
    accountId: Id,
    subject: z.string().max(2000),
    participants: z.array(MailAddress),
    messageCount: z.number().int().positive(),
    unreadCount: z.number().int().nonnegative(),
    lastMessageAt: IsoDateTime,
    /** 最后一封邮件的 id。 */
    lastMessageId: Id,
});
export type MailThread = z.infer<typeof MailThread>;

/**
 * 草稿附件的来源(ADR 0016 第 6 节):只能是被回复邮件的附件,或授权目录中的文件(按 fs.read 的路径规则校验)。
 */
export const MailDraftAttachment = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('mail'), attachmentId: Id }),
    z.strictObject({ kind: z.literal('file'), path: z.string().min(1).max(4096) }),
]);
export type MailDraftAttachment = z.infer<typeof MailDraftAttachment>;

/** 草稿中的附件:来源加上审批卡片要显示的文件名与大小。 */
export const MailDraftAttachmentInfo = z.object({
    source: MailDraftAttachment,
    filename: z.string().max(500),
    size: z.number().int().nonnegative(),
});
export type MailDraftAttachmentInfo = z.infer<typeof MailDraftAttachmentInfo>;

/** 本地草稿(ADR 0016 第 6 节):只保存在本地,发送一定要审批。 */
export const MailDraftInput = z.strictObject({
    accountId: Id,
    to: z.array(MailAddressString).min(1).max(100),
    cc: z.array(MailAddressString).max(100).default([]),
    subject: z.string().max(2000),
    text: z.string().max(100_000),
    /** 回复哪一封邮件;In-Reply-To / References 由 core 据此设置,不由模型提供。 */
    replyToMessageId: Id.optional(),
    attachments: z.array(MailDraftAttachment).max(20).default([]),
});
export type MailDraftInput = z.input<typeof MailDraftInput>;

export const MailDraft = z.object({
    id: Id,
    accountId: Id,
    to: z.array(MailAddressString),
    cc: z.array(MailAddressString),
    subject: z.string(),
    text: z.string(),
    replyToMessageId: Id.nullable(),
    attachments: z.array(MailDraftAttachmentInfo),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
});
export type MailDraft = z.infer<typeof MailDraft>;

/**
 * mail.send 的输入:只有草稿 id(ADR 0016 第 6 节,业主决定 4)。发送的就是保存着的那份草稿,
 * 未知字段(如 to、text)一律拒绝,模型不能在发送时改动内容。
 */
export const MailSendInput = z.strictObject({
    draftId: Id,
});
export type MailSendInput = z.infer<typeof MailSendInput>;

/** 常见邮箱的默认服务器与授权码说明(ADR 0016 第 1 节;GET /mail/presets)。 */
export const MailPreset = z.object({
    id: z.string(),
    label: z.string(),
    imap: MailServer,
    smtp: MailServer,
    /** 只作说明:`auto` 策略在这个主机上是否 APPEND(163 与 Gmail 会自动保存,为 false)。新建账户不必传它。 */
    appendToSent: z
        .boolean()
        .describe(
            'Informational: whether the auto policy appends on this host (false for 163 and Gmail). Not needed when adding an account.',
        ),
    /** 如何开启 IMAP 与取得授权码 / 应用专用密码。 */
    help: z.string(),
});
export type MailPreset = z.infer<typeof MailPreset>;

/** POST /mail/accounts/{id}/test 的结果:分别测 IMAP 与 SMTP,错误是人能看懂、已脱敏的说明。 */
export const MailConnectionCheck = z.object({ ok: z.boolean(), error: z.string().max(500).nullable() });
export const MailConnectionTest = z.object({ imap: MailConnectionCheck, smtp: MailConnectionCheck });
export type MailConnectionTest = z.infer<typeof MailConnectionTest>;

/** POST /mail/accounts/{id}/sync 的结果。 */
export const MailSyncResult = z.object({
    ok: z.boolean(),
    error: z.string().max(500).nullable(),
    /** 新增、更新已读状态、删除的邮件数。 */
    added: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    /** 还有没拉完的新邮件(每次每个文件夹最多拉一批),会很快自动继续。 */
    more: z.boolean(),
});
export type MailSyncResult = z.infer<typeof MailSyncResult>;

/** GET /mail/messages 的查询参数(M3 PR 4,Web 的邮件列表)。按时间倒序;before 为上一页最后一封的时间。 */
export const MailMessageQuery = z.object({
    accountId: Id.optional(),
    folder: z.enum(['inbox', 'sent']).optional(),
    unreadOnly: z
        .enum(['true', 'false'])
        .transform((v) => v === 'true')
        .optional(),
    before: IsoDateTime.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MailMessageQuery = z.input<typeof MailMessageQuery>;

/** PATCH /mail/drafts/{id}:用户在 Web 中修改草稿;修改后等待中的发送审批作废(ADR 0016 第 6 节)。 */
export const MailDraftPatch = z.strictObject({
    to: z.array(MailAddressString).min(1).max(100).optional(),
    cc: z.array(MailAddressString).max(100).optional(),
    subject: z.string().max(2000).optional(),
    text: z.string().max(100_000).optional(),
});
export type MailDraftPatch = z.infer<typeof MailDraftPatch>;

/**
 * POST /mail/messages/{id}/ask 的结果:新建的会话(从一开始就视为读过不可信内容)与建议的第一句话。
 * prompt 只含邮件 id,不含邮件里的任何文字,所以邮件中的地址不会被当成「主人给出的地址」(ADR 0016 第 7 节)。
 */
export const MailAskResult = z.object({ sessionId: Id, prompt: z.string() });
export type MailAskResult = z.infer<typeof MailAskResult>;

/** POST /mail/attachments/{id}/knowledge-base 的结果。 */
export const MailAttachmentKbResult = z.object({
    itemId: Id,
    chunks: z.number().int().nonnegative(),
    /** 解析失败等原因;为 null 表示成功。 */
    error: z.string().max(300).nullable(),
});
export type MailAttachmentKbResult = z.infer<typeof MailAttachmentKbResult>;
