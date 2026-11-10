// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// mail 条目提供者(ADR 0016,M3 PR 4):「邮件 → 账户 → 文件夹 → 会话串 → 邮件」,加入知识库的附件挂在邮件下。
// 条目只有主题与发件人 / 日期摘要,正文不进 items_fts(正文的全文检索在 mail_fts,ADR 0016 第 3 节)。
// 账户的缓存没有变化时(指纹相同)跳过整个账户,1 万封邮件也不会每次重写。
import type { Item, ItemContent } from '@fatcat-ai/shared';
import type { MailItemRow } from '@fatcat-ai/storage';
import { type ItemProvider, type OpenContext, type SyncContext, textContent } from '@fatcat-ai/items';
import { fullText } from './tools.js';

export const MAIL_ROOT_REF = 'mail';

const FOLDER_TITLES: Record<string, string> = { inbox: '收件箱', sent: '已发送' };

function from(row: MailItemRow): string {
    return row.from ? (row.from.name ?? row.from.address) : '(未知发件人)';
}

export const mailProvider: ItemProvider = {
    id: 'mail',
    async sync(ctx: SyncContext) {
        const { repos, ownerId } = ctx;
        const accounts = repos.mail.list(ownerId);
        if (accounts.length === 0 && !repos.items.bySource(ownerId, 'mail', MAIL_ROOT_REF)) return;
        const root = ctx.upsert({
            sourceRef: MAIL_ROOT_REF,
            kind: 'category',
            type: 'mail',
            title: '邮件',
            icon: 'mail',
            parentId: null,
        });
        const keepAccounts = new Set<string>();
        for (const account of accounts) {
            const ref = `account:${account.id}`;
            keepAccounts.add(ref);
            const signature = `${repos.mailCache.signature(account.id)}:${account.label}:${account.address}`;
            const existing = repos.items.bySource(ownerId, 'mail', ref);
            if (
                existing &&
                !existing.deletedAt &&
                (existing.meta as { signature?: string } | null)?.signature === signature
            ) {
                continue;
            }
            const accountItem = ctx.upsert({
                sourceRef: ref,
                kind: 'category',
                type: 'mail.account',
                title: account.label,
                summary: account.address,
                meta: { accountId: account.id },
                parentId: root.id,
            });
            const rows = repos.mailCache.itemRows(account.id);
            const keepFolders = new Set<string>();
            for (const folder of repos.mail.folders(account.id)) {
                const folderRef = `folder:${folder.id}`;
                keepFolders.add(folderRef);
                const folderItem = ctx.upsert({
                    sourceRef: folderRef,
                    kind: 'category',
                    type: 'mail.folder',
                    title: FOLDER_TITLES[folder.specialUse ?? ''] ?? folder.name,
                    meta: { folderId: folder.id },
                    parentId: accountItem.id,
                    position: folder.specialUse === 'inbox' ? 0 : 1,
                });
                // 按会话串分组;rows 已按时间先后排序
                const threads = new Map<string, MailItemRow[]>();
                for (const r of rows) {
                    if (r.folderId !== folder.id) continue;
                    const list = threads.get(r.threadKey) ?? [];
                    list.push(r);
                    threads.set(r.threadKey, list);
                }
                const keepThreads = new Set<string>();
                for (const [threadKey, messages] of threads) {
                    const threadRef = `thread:${folder.id}:${threadKey}`;
                    keepThreads.add(threadRef);
                    const last = messages[messages.length - 1]!;
                    const threadItem = ctx.upsert({
                        sourceRef: threadRef,
                        kind: 'category',
                        type: 'mail.thread',
                        title: messages[0]!.subject || '(无主题)',
                        summary: `${messages.length} 封 · ${from(last)} · ${last.date.slice(0, 10)}`,
                        meta: { accountId: account.id, threadKey, lastDate: last.date },
                        parentId: folderItem.id,
                    });
                    const keepMessages = new Set<string>();
                    messages.forEach((m, i) => {
                        const messageRef = `message:${m.id}`;
                        keepMessages.add(messageRef);
                        const messageItem = ctx.upsert({
                            sourceRef: messageRef,
                            kind: 'content',
                            type: 'mail.message',
                            title: m.subject || '(无主题)',
                            summary: `${from(m)} · ${m.date.slice(0, 16).replace('T', ' ')}`,
                            meta: { messageId: m.id, date: m.date },
                            parentId: threadItem.id,
                            position: i,
                        });
                        const keepAttachments = new Set<string>();
                        for (const a of m.attachments) {
                            const attRef = `attachment:${a.id}`;
                            keepAttachments.add(attRef);
                            ctx.upsert({
                                sourceRef: attRef,
                                kind: 'content',
                                type: 'mail.attachment',
                                title: a.filename,
                                summary: `${a.size} bytes`,
                                meta: { attachmentId: a.id, messageId: m.id, size: a.size },
                                parentId: messageItem.id,
                            });
                        }
                        ctx.removeMissing(messageItem.id, keepAttachments);
                    });
                    ctx.removeMissing(threadItem.id, keepMessages);
                }
                ctx.removeMissing(folderItem.id, keepThreads);
            }
            ctx.removeMissing(accountItem.id, keepFolders);
            // 子树写完才记下指纹:中途失败时下次会重新同步
            ctx.upsert({
                sourceRef: ref,
                kind: 'category',
                type: 'mail.account',
                title: account.label,
                summary: account.address,
                meta: { accountId: account.id, signature },
                parentId: root.id,
            });
        }
        ctx.removeMissing(root.id, keepAccounts);
    },

    /** 打开单封邮件:头信息与纯文本正文;邮件缓存按 owner 限定,别人的邮件打不开。 */
    async open(item: Item, ctx: OpenContext): Promise<ItemContent> {
        const meta = (item.meta ?? {}) as { messageId?: string; attachmentId?: string };
        if (item.type === 'mail.message' && meta.messageId) {
            const m = ctx.repos.mailCache.get(ctx.ownerId, meta.messageId);
            if (!m) throw new Error('this e-mail is no longer in the local cache');
            return textContent(fullText(m, 60_000).text);
        }
        if (item.type === 'mail.attachment' && meta.attachmentId) {
            // 加入知识库的附件:内容就是入库时的分块(凭据已替换),原文件不保存在本地
            const n = ctx.repos.kb.source(item.id)?.chunks ?? 0;
            const parts: string[] = [];
            for (let i = 0; i < n; i++) {
                const chunk = ctx.repos.kb.get(ctx.ownerId, item.id, i);
                if (chunk) parts.push(chunk.text);
            }
            return textContent(parts.length ? parts.join('\n\n') : item.title);
        }
        return textContent(`${item.title}\n${item.summary ?? ''}`);
    },
};
