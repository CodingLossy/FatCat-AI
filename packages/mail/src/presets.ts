// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 常见邮箱的默认服务器与授权码说明(开发计划 M3 第 1 条;ADR 0016 第 1 节)。
import type { MailPreset, MailSentCopy } from '@ai-personal/shared';

export const MAIL_PRESETS: readonly MailPreset[] = [
    {
        id: 'qq',
        label: 'QQ 邮箱',
        imap: { host: 'imap.qq.com', port: 993, security: 'tls' },
        smtp: { host: 'smtp.qq.com', port: 465, security: 'tls' },
        appendToSent: true,
        help: '在 QQ 邮箱网页版「设置 → 账号」中开启 IMAP/SMTP 服务并生成授权码;密码处填授权码的引用,不是 QQ 密码。',
    },
    {
        id: '163',
        label: '网易 163 邮箱',
        imap: { host: 'imap.163.com', port: 993, security: 'tls' },
        smtp: { host: 'smtp.163.com', port: 465, security: 'tls' },
        // 163 经 SMTP 发出的邮件会自动保存到「已发送」;再 APPEND 会多出一份(同一 Message-ID 两个 UID)
        appendToSent: false,
        help: '在 163 邮箱网页版「设置 → POP3/SMTP/IMAP」中开启 IMAP/SMTP 服务并设置客户端授权码;密码处填授权码的引用。',
    },
    {
        id: 'gmail',
        label: 'Gmail',
        imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
        smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
        // Gmail 经 SMTP 发出的邮件会自动出现在「已发送」中,不需要再 APPEND
        appendToSent: false,
        help: '在 Google 账号中开启两步验证,然后在「应用专用密码」中生成一个密码;密码处填它的引用。不支持 OAuth 登录。',
    },
];

/** 经 SMTP 发信后会自动把邮件存进「已发送」的 IMAP 服务器;`auto` 策略对它们不 APPEND,否则会有两份。 */
const SERVERS_THAT_SAVE_SENT: ReadonlySet<string> = new Set(['imap.163.com', 'imap.gmail.com']);

/** 这个 IMAP 主机是否已知会自动保存经 SMTP 发出的邮件。 */
export function serverSavesSent(imapHost: string): boolean {
    return SERVERS_THAT_SAVE_SENT.has(imapHost.trim().toLowerCase());
}

/** 按策略与主机,发送成功后 AI-Personal 是否 APPEND 一份(ADR 0016 第 14 节)。显式的 `append` / `off` 总是生效。 */
export function appendsToSent(account: { sentCopy: MailSentCopy; imap: { host: string } }): boolean {
    if (account.sentCopy === 'auto') return !serverSavesSent(account.imap.host);
    return account.sentCopy === 'append';
}

/**
 * 发送前决定「已发送」副本怎么处理:
 * - `append`:AI-Personal 把发出的原文 APPEND 到 `folder`;
 * - `server`:`auto` 策略且主机会自动保存,不 APPEND(服务器那一份不经过也不核实);
 * - `off`:账户关闭了 APPEND;
 * - `no-sent-folder`:要 APPEND 但还没同步到「已发送」文件夹。
 */
export type SentCopyPlan =
    { action: 'append'; folder: string } | { action: 'server' | 'off' | 'no-sent-folder'; folder: null };

export function planSentCopy(
    account: { sentCopy: MailSentCopy; imap: { host: string } },
    sentFolder: string | null,
): SentCopyPlan {
    if (account.sentCopy === 'off') return { action: 'off', folder: null };
    if (!appendsToSent(account)) return { action: 'server', folder: null };
    return sentFolder ? { action: 'append', folder: sentFolder } : { action: 'no-sent-folder', folder: null };
}
