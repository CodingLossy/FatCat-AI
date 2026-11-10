// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 把邮件附件加入知识库(ADR 0016 第 3 节,M3 PR 4):只由用户在 Web 上点击触发,没有对应的工具。
// 附件在邮件子进程中下载,文档在解析 worker 中解析;只保存分块(凭据已替换),不在本地保存原文件。
import { extname } from 'node:path';
import type { MailAttachmentKbResult } from '@fatcat-ai/shared';
import type { ItemService, KnowledgeBase } from '@fatcat-ai/items';
import { KB_EXTENSIONS, decodeText } from '@fatcat-ai/items';
import type { Repositories } from '@fatcat-ai/storage';
import { documentKind, MAX_DOCUMENT_BYTES, parseInWorker } from '@fatcat-ai/tools';
import type { MailJobRunner } from './run.js';

export class AttachmentError extends Error {
    constructor(
        readonly status: 400 | 404,
        message: string,
    ) {
        super(message);
    }
}

export interface AttachmentKbDeps {
    repos: Repositories;
    items: Pick<ItemService, 'sync'>;
    kb: Pick<KnowledgeBase, 'indexContent'>;
    runner: MailJobRunner;
    secret: (ref: string) => string | null;
    /** 测试中替换文档解析(默认在 worker 中解析 PDF / DOCX / XLSX)。 */
    parse?: (kind: 'pdf' | 'docx' | 'xlsx', data: Buffer) => Promise<{ text: string }>;
}

export async function addAttachmentToKb(
    deps: AttachmentKbDeps,
    ownerId: string,
    attachmentId: string,
): Promise<MailAttachmentKbResult> {
    const { repos } = deps;
    const att = repos.mailCache.attachment(ownerId, attachmentId);
    if (!att) throw new AttachmentError(404, 'Attachment not found.');
    const ext = extname(att.filename).toLowerCase();
    if (!KB_EXTENSIONS.has(ext)) {
        throw new AttachmentError(
            400,
            `Only ${[...KB_EXTENSIONS].join(', ')} files can be added to the knowledge base.`,
        );
    }
    if (att.size > MAX_DOCUMENT_BYTES) throw new AttachmentError(400, 'The attachment is larger than 20 MB.');
    const message = repos.mailCache.get(ownerId, att.messageId)!;
    const account = repos.mail.get(ownerId, message.accountId);
    if (!account) throw new AttachmentError(404, 'Mail account not found.');
    const password = deps.secret(account.passwordRef);
    if (!password) throw new AttachmentError(400, `The password referenced by ${account.passwordRef} is not set.`);

    const data = Buffer.from(
        await deps.runner({
            kind: 'download',
            input: {
                imap: { server: account.imap, username: account.username, password },
                folderPath: message.folderPath,
                uid: message.uid,
                part: att.part,
                maxBytes: MAX_DOCUMENT_BYTES,
            },
        }),
    );

    let text = '';
    let error: string | null = null;
    try {
        const kind = documentKind(att.filename);
        if (kind) text = (await (deps.parse ?? parseInWorker)(kind, data)).text;
        else if (data.subarray(0, 8192).includes(0))
            throw new Error('this is a binary file and cannot be read as text');
        else text = decodeText(data);
    } catch (e) {
        error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }

    // 标记为已下载后同步条目:附件条目出现在邮件下面,再把分块挂到它上面
    repos.mailCache.markDownloaded(att.id);
    await deps.items.sync(ownerId);
    const ref = `attachment:${att.id}`;
    // 正在进行的同步可能早于上面的标记:再同步一次
    if (!repos.items.bySource(ownerId, 'mail', ref)) await deps.items.sync(ownerId);
    const item = repos.items.bySource(ownerId, 'mail', ref);
    if (!item) throw new AttachmentError(404, 'The attachment could not be added to the knowledge map.');
    const chunks = error
        ? 0
        : deps.kb.indexContent(ownerId, {
              itemId: item.id,
              name: att.filename,
              text,
              size: data.length,
              pdf: ext === '.pdf',
          });
    return { itemId: item.id, chunks, error };
}
