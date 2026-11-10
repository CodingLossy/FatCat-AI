// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 邮件账户卡片上「已发送」副本的说明(ADR 0016 第 14 节)。服务器会不会自己保存,按预设里的
// appendToSent(auto 在该主机上的结果)判断,不在前端另写一份主机列表。
import type { MailAccount, MailPreset } from '@fatcat-ai/shared';

export type SentCopyNote = 'mail.sentCopyNote.server' | 'mail.sentCopyNote.append' | 'mail.sentCopyNote.off';

const norm = (host: string) => host.trim().toLowerCase();

/** 这个账户的 IMAP 主机是否属于「服务器会自动保存已发送」的预设(163 / Gmail)。 */
export function serverSavesSent(account: Pick<MailAccount, 'imap'>, presets: readonly MailPreset[]): boolean {
    const host = norm(account.imap.host);
    return presets.some((p) => !p.appendToSent && norm(p.imap.host) === host);
}

export function sentCopyNote(account: Pick<MailAccount, 'sentCopy' | 'appendToSent'>): SentCopyNote {
    if (account.sentCopy === 'off') return 'mail.sentCopyNote.off';
    return account.appendToSent ? 'mail.sentCopyNote.append' : 'mail.sentCopyNote.server';
}

/** 选了「总是保存」而服务器本身也会保存:「已发送」里会有两份。 */
export function sentCopyDuplicate(
    account: Pick<MailAccount, 'sentCopy' | 'imap'>,
    presets: readonly MailPreset[],
): boolean {
    return account.sentCopy === 'append' && serverSavesSent(account, presets);
}
