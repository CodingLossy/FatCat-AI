// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 图片附件的元数据(ADR 0020 第 3 节)。文件本身由服务器写在数据目录 attachments/ 下,这里不碰文件。
import type { Attachment, AttachmentMediaType } from '@fatcat-ai/shared';
import type { Connection } from './db.js';
import { newId } from './ids.js';
import { selectList } from './schema.js';

interface Row {
    id: string;
    ownerId: string;
    messageId: string | null;
    mediaType: AttachmentMediaType;
    bytes: number;
    sha256: string;
    fileName: string;
    createdAt: string;
}

const toAttachment = (row: Row): Attachment => ({
    id: row.id,
    messageId: row.messageId,
    mediaType: row.mediaType,
    bytes: row.bytes,
    sha256: row.sha256,
    fileName: row.fileName,
    createdAt: row.createdAt,
});

export interface NewAttachment {
    mediaType: AttachmentMediaType;
    bytes: number;
    sha256: string;
    fileName: string;
}

export function createAttachmentRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const select = `SELECT ${selectList('message_attachments')} FROM message_attachments`;
    const q = {
        insert: sqlite.prepare(
            `INSERT INTO message_attachments (id, owner_id, message_id, media_type, bytes, sha256, file_name, created_at)
             VALUES (@id, @ownerId, NULL, @mediaType, @bytes, @sha256, @fileName, @createdAt)`,
        ),
        get: sqlite.prepare<[string, string], Row>(`${select} WHERE owner_id = ? AND id = ?`),
        link: sqlite.prepare<[string, string, string]>(
            'UPDATE message_attachments SET message_id = ? WHERE owner_id = ? AND id = ? AND message_id IS NULL',
        ),
        forSession: sqlite.prepare<[string, string], { id: string }>(
            `SELECT a.id FROM message_attachments a JOIN messages m ON m.id = a.message_id
             WHERE a.owner_id = ? AND m.session_id = ?`,
        ),
        unlinkedBefore: sqlite.prepare<[string], { id: string }>(
            'SELECT id FROM message_attachments WHERE message_id IS NULL AND created_at < ?',
        ),
        deleteUnlinkedBefore: sqlite.prepare<[string]>(
            'DELETE FROM message_attachments WHERE message_id IS NULL AND created_at < ?',
        ),
        exists: sqlite.prepare<[string], { n: number }>('SELECT count(*) AS n FROM message_attachments WHERE id = ?'),
    };

    const linkAll = sqlite.transaction((ownerId: string, ids: readonly string[], messageId: string): boolean => {
        for (const id of ids) {
            if (q.link.run(messageId, ownerId, id).changes !== 1) throw new AttachmentLinkError(id);
        }
        return true;
    });

    const removeUnlinked = sqlite.transaction((cutoff: string): string[] => {
        const ids = q.unlinkedBefore.all(cutoff).map((r) => r.id);
        q.deleteUnlinkedBefore.run(cutoff);
        return ids;
    });

    return {
        /** id 可由调用方先生成(先写文件再建行);省略时新建。 */
        create(ownerId: string, input: NewAttachment, id = newId(now())): Attachment {
            q.insert.run({ id, ownerId, ...input, createdAt: now().toISOString() });
            return toAttachment(q.get.get(ownerId, id)!);
        },
        /** 只按 ownerId 取;别人的附件与不存在的一样返回 null。 */
        get(ownerId: string, id: string): Attachment | null {
            const row = q.get.get(ownerId, id);
            return row ? toAttachment(row) : null;
        },
        /**
         * 把尚未发送的附件挂到消息上;任何一个不属于本人、不存在或已被引用时抛 AttachmentLinkError,整体回滚。
         * 在外层事务中调用时随外层一起回滚。
         */
        link(ownerId: string, ids: readonly string[], messageId: string): void {
            linkAll(ownerId, ids, messageId);
        },
        /** 会话中全部附件的 id(删除会话前取出,用于删除文件)。 */
        idsForSession(ownerId: string, sessionId: string): string[] {
            return q.forSession.all(ownerId, sessionId).map((r) => r.id);
        },
        /** 删除早于 cutoff 且未被任何消息引用的附件行,返回被删除的 id(调用方再删文件)。 */
        removeUnlinkedBefore(cutoff: Date): string[] {
            return removeUnlinked(cutoff.toISOString());
        },
        /** 是否还有这一行(清理孤立文件时用,不按 owner 过滤)。 */
        exists(id: string): boolean {
            return (q.exists.get(id)?.n ?? 0) > 0;
        },
    };
}

export type AttachmentRepository = ReturnType<typeof createAttachmentRepository>;

export class AttachmentLinkError extends Error {
    override readonly name = 'AttachmentLinkError';
    constructor(readonly attachmentId: string) {
        super(`attachment ${attachmentId} is missing, not owned, or already used`);
    }
}
