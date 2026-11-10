// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 主线程与同步 worker 之间传递的数据(ADR 0016 第 2 节)。只有可结构化克隆的普通对象。
import type { MailAddress, MailServer } from '@ai-personal/shared';

export type FolderRole = 'inbox' | 'sent';

/** 主线程已知的文件夹状态。 */
export interface KnownFolder {
    path: string;
    uidValidity: number | null;
    lastUid: number;
    highestModseq: string | null;
    /** 本地缓存中该文件夹的全部 UID(同步窗口),用于发现 FLAGS 变化与删除。 */
    uids: number[];
    /** 本地记录的未读 UID,用于只回报真正变化的 FLAGS。 */
    unreadUids: number[];
}

export interface ImapConnectOptions {
    server: MailServer;
    username: string;
    password: string;
    /** 只在测试中使用:信任的 CA(PEM)。生产中一律按系统 CA 校验证书。 */
    ca?: string;
}

export interface SyncInput extends ImapConnectOptions {
    initialSyncDays: number;
    folders: KnownFolder[];
    /** ISO 时间;首次同步的 SINCE 由它往前推。 */
    now: string;
    /** 每个文件夹每次最多拉多少封新邮件;剩下的下次再拉。 */
    batchSize?: number;
}

export interface ParsedAttachment {
    /** IMAP 正文部分编号(如 2、1.2),以后下载附件时用。 */
    part: string;
    filename: string;
    contentType: string;
    size: number;
}

export interface ParsedMessage {
    uid: number;
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    from: MailAddress | null;
    replyTo: MailAddress[];
    to: MailAddress[];
    cc: MailAddress[];
    subject: string;
    date: string;
    unread: boolean;
    text: string;
    attachments: ParsedAttachment[];
}

export interface FolderResult {
    path: string;
    name: string;
    role: FolderRole;
    uidValidity: number;
    highestModseq: string | null;
    /** UIDVALIDITY 变了:主线程先清空该文件夹的缓存。 */
    reset: boolean;
    lastUid: number;
    messages: ParsedMessage[];
    /** 已读状态有变化的已缓存邮件。 */
    flags: { uid: number; unread: boolean }[];
    /** 服务器上已不存在的 UID。 */
    deleted: number[];
    /** 还有新邮件没拉完。 */
    more: boolean;
}

export interface SyncOutput {
    folders: FolderResult[];
}

/** 邮件服务器的一次只读会话;实现见 client.ts(imapflow),测试中用内存实现。 */
export interface ImapSession {
    listFolders(): Promise<{ path: string; name: string; specialUse: string | null }[]>;
    /** 只读打开文件夹。highestModseq 为 null 表示服务器不支持 CONDSTORE。 */
    open(path: string): Promise<{ uidValidity: number; highestModseq: string | null }>;
    /** 收到时间不早于 since 的 UID。 */
    searchSince(since: Date): Promise<number[]>;
    /** 范围内存在的 UID(如 "1:500"、"501:*")。 */
    searchUids(range: string): Promise<number[]>;
    /** 范围内的已读状态;changedSince 给出时只返回 MODSEQ 更大的。 */
    fetchFlags(range: string, changedSince?: string): Promise<{ uid: number; unread: boolean }[]>;
    /** 取完整邮件并解析(不会把服务器上的邮件标为已读)。 */
    fetchMessages(uids: number[]): Promise<ParsedMessage[]>;
    close(): Promise<void>;
}

/** 一封要发送的邮件(ADR 0016 第 6 节):内容来自已保存的草稿,附件已由服务器校验过来源。 */
export interface SendInput {
    smtp: ImapConnectOptions;
    /** 下载被回复邮件的附件、APPEND 到「已发送」时用。 */
    imap: ImapConnectOptions;
    from: MailAddress;
    to: string[];
    cc: string[];
    subject: string;
    text: string;
    inReplyTo: string | null;
    references: string[];
    /** 被回复邮件中的附件:按文件夹 + UID + 正文部分编号下载。 */
    mailAttachments: { folderPath: string; uid: number; part: string; filename: string; contentType: string }[];
    /** 授权目录中的文件(绝对路径,已校验)。 */
    fileAttachments: { path: string; filename: string }[];
    /** 「已发送」文件夹;为 null 时不 APPEND。 */
    appendTo: string | null;
}

export interface SendOutput {
    messageId: string;
    accepted: string[];
    rejected: string[];
    appended: boolean;
    /** APPEND 失败的原因(发送本身已经成功)。 */
    appendError: string | null;
}

/** 下载被缓存邮件的一个附件(用户点「加入知识库」时)。 */
export interface DownloadInput {
    imap: ImapConnectOptions;
    folderPath: string;
    uid: number;
    part: string;
    maxBytes: number;
}
