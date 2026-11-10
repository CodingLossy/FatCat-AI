// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 邮件账户、文件夹与本地缓存(ADR 0016)。账户只存密码引用;同步结果在一个事务里写入。
import type {
    MailAccount,
    MailAccountInput,
    MailAccountPatch,
    MailAddress,
    MailFolder,
    MailSentCopy,
} from '@ai-personal/shared';
import type { Connection } from './db.js';
import { newId } from './ids.js';

/** 只存策略 `sentCopy`;响应里的 `appendToSent` 由服务器按策略与主机算出(ADR 0016 第 14 节)。 */
export type MailAccountRecord = Omit<MailAccount, 'passwordStatus' | 'appendToSent'>;

/** 已解析默认值的新建输入;`appendToSent` / `sentCopy` 都不给时策略为 `auto`。 */
export type MailAccountCreate = Omit<Required<MailAccountInput>, 'appendToSent' | 'sentCopy'> &
    Pick<MailAccountInput, 'appendToSent' | 'sentCopy'>;

/** 输入里的显式选择:`sentCopy` 优先,其次是旧字段 `appendToSent`;都没给时为 undefined。 */
function explicitSentCopy(input: Pick<MailAccountInput, 'appendToSent' | 'sentCopy'>): MailSentCopy | undefined {
    if (input.sentCopy) return input.sentCopy;
    if (input.appendToSent === undefined) return undefined;
    return input.appendToSent ? 'append' : 'off';
}

export interface MailMessageSync {
    uid: number;
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    /** 这封邮件自己算出的会话串键;写入时如果找到已缓存的相关邮件,沿用它们的键。 */
    threadKey: string;
    from: MailAddress | null;
    replyTo: MailAddress[];
    to: MailAddress[];
    cc: MailAddress[];
    subject: string;
    date: string;
    unread: boolean;
    text: string;
    attachments: { part: string; filename: string; contentType: string; size: number }[];
}

export interface MailFolderSync {
    path: string;
    name: string;
    role: 'inbox' | 'sent';
    uidValidity: number;
    highestModseq: string | null;
    reset: boolean;
    lastUid: number;
    messages: MailMessageSync[];
    flags: { uid: number; unread: boolean }[];
    deleted: number[];
}

export interface MailKnownFolder {
    path: string;
    uidValidity: number | null;
    lastUid: number;
    highestModseq: string | null;
    uids: number[];
    unreadUids: number[];
}

interface AccountRow {
    id: string;
    label: string;
    address: string;
    username: string;
    passwordRef: string;
    imapJson: string;
    smtpJson: string;
    initialSyncDays: number;
    syncIntervalMinutes: number;
    sentCopy: MailSentCopy;
    enabled: number;
    lastSyncedAt: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
}

const ACCOUNT_COLUMNS = `id, label, address, username, password_ref AS passwordRef, imap_json AS imapJson,
    smtp_json AS smtpJson, initial_sync_days AS initialSyncDays, sync_interval_minutes AS syncIntervalMinutes,
    sent_copy AS sentCopy, enabled, last_synced_at AS lastSyncedAt, last_error AS lastError,
    created_at AS createdAt, updated_at AS updatedAt`;

function toAccount(row: AccountRow): MailAccountRecord {
    return {
        id: row.id,
        label: row.label,
        address: row.address,
        username: row.username,
        passwordRef: row.passwordRef,
        imap: JSON.parse(row.imapJson) as MailAccount['imap'],
        smtp: JSON.parse(row.smtpJson) as MailAccount['smtp'],
        initialSyncDays: row.initialSyncDays,
        syncIntervalMinutes: row.syncIntervalMinutes,
        sentCopy: row.sentCopy,
        enabled: row.enabled === 1,
        lastSyncedAt: row.lastSyncedAt,
        lastError: row.lastError,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function snippetOf(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function createMailRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const q = {
        list: sqlite.prepare<[string], AccountRow>(
            `SELECT ${ACCOUNT_COLUMNS} FROM mail_accounts WHERE owner_id = ? ORDER BY created_at, id`,
        ),
        get: sqlite.prepare<[string, string], AccountRow>(
            `SELECT ${ACCOUNT_COLUMNS} FROM mail_accounts WHERE owner_id = ? AND id = ?`,
        ),
        insert: sqlite.prepare(
            `INSERT INTO mail_accounts (id, owner_id, label, address, username, password_ref, imap_json, smtp_json,
               initial_sync_days, sync_interval_minutes, append_to_sent, sent_copy, enabled, created_at, updated_at)
             VALUES (@id, @ownerId, @label, @address, @username, @passwordRef, @imap, @smtp, @initialSyncDays,
               @syncIntervalMinutes, @appendToSent, @sentCopy, @enabled, @at, @at)`,
        ),
        update: sqlite.prepare(
            `UPDATE mail_accounts SET label = @label, address = @address, username = @username,
               password_ref = @passwordRef, imap_json = @imap, smtp_json = @smtp, initial_sync_days = @initialSyncDays,
               sync_interval_minutes = @syncIntervalMinutes, append_to_sent = @appendToSent, sent_copy = @sentCopy,
               enabled = @enabled,
               next_sync_at = NULL, failures = 0, updated_at = @at
             WHERE id = @id`,
        ),
        delete: sqlite.prepare<[string, string]>('DELETE FROM mail_accounts WHERE owner_id = ? AND id = ?'),
        due: sqlite.prepare<[string], { ownerId: string; id: string }>(
            `SELECT owner_id AS ownerId, id FROM mail_accounts
             WHERE enabled = 1 AND (next_sync_at IS NULL OR next_sync_at <= ?) ORDER BY next_sync_at, id`,
        ),
        failures: sqlite.prepare<[string], { failures: number }>('SELECT failures FROM mail_accounts WHERE id = ?'),
        record: sqlite.prepare(
            `UPDATE mail_accounts SET last_synced_at = COALESCE(@syncedAt, last_synced_at), last_error = @error,
               failures = @failures, next_sync_at = @nextSyncAt WHERE id = @id`,
        ),
        folders: sqlite.prepare<
            [string],
            {
                id: string;
                path: string;
                name: string;
                specialUse: string | null;
                uidValidity: number | null;
                lastUid: number;
                highestModseq: string | null;
                lastSyncedAt: string | null;
                messageCount: number;
                unreadCount: number;
            }
        >(
            `SELECT f.id, f.path, f.name, f.special_use AS specialUse, f.uid_validity AS uidValidity,
                    f.last_uid AS lastUid, f.highest_modseq AS highestModseq, f.last_synced_at AS lastSyncedAt,
                    COUNT(mf.uid) AS messageCount, COALESCE(SUM(m.unread), 0) AS unreadCount
             FROM mail_folders f
             LEFT JOIN mail_message_folders mf ON mf.folder_id = f.id
             LEFT JOIN mail_messages m ON m.id = mf.message_id
             WHERE f.account_id = ? GROUP BY f.id ORDER BY f.path`,
        ),
        folderByPath: sqlite.prepare<[string, string], { id: string }>(
            'SELECT id FROM mail_folders WHERE account_id = ? AND path = ?',
        ),
        insertFolder: sqlite.prepare(
            `INSERT INTO mail_folders (id, account_id, path, name, special_use) VALUES (@id, @accountId, @path, @name, @role)`,
        ),
        updateFolder: sqlite.prepare(
            `UPDATE mail_folders SET name = @name, special_use = @role, uid_validity = @uidValidity, last_uid = @lastUid,
               highest_modseq = @highestModseq, last_synced_at = @at WHERE id = @id`,
        ),
        folderUids: sqlite.prepare<[string], { uid: number; unread: number }>(
            `SELECT mf.uid, m.unread FROM mail_message_folders mf JOIN mail_messages m ON m.id = mf.message_id
             WHERE mf.folder_id = ? ORDER BY mf.uid`,
        ),
        clearFolder: sqlite.prepare<[string]>('DELETE FROM mail_message_folders WHERE folder_id = ?'),
        byMessageId: sqlite.prepare<[string, string], { id: string; threadKey: string }>(
            'SELECT id, thread_key AS threadKey FROM mail_messages WHERE account_id = ? AND message_id = ?',
        ),
        /** 已缓存的回复(先于原邮件到达):它们的 In-Reply-To 或 References 指向这封邮件。 */
        replyTo: sqlite.prepare<[string, string, string], { threadKey: string }>(
            `SELECT thread_key AS threadKey FROM mail_messages
             WHERE account_id = ? AND (in_reply_to = ? OR references_json LIKE ? ESCAPE '\\') LIMIT 1`,
        ),
        insertMessage: sqlite.prepare(
            `INSERT INTO mail_messages (id, account_id, message_id, in_reply_to, references_json, thread_key, from_json,
               reply_to_json, to_json, cc_json, subject, date, unread, body, snippet, created_at)
             VALUES (@id, @accountId, @messageId, @inReplyTo, @references, @threadKey, @from, @replyTo, @to, @cc,
               @subject, @date, @unread, @body, @snippet, @at)`,
        ),
        insertAttachment: sqlite.prepare(
            `INSERT INTO mail_attachments (id, message_id, part, filename, content_type, size)
             VALUES (@id, @messageId, @part, @filename, @contentType, @size)`,
        ),
        link: sqlite.prepare(
            'INSERT OR REPLACE INTO mail_message_folders (folder_id, uid, message_id) VALUES (?, ?, ?)',
        ),
        setUnread: sqlite.prepare<[number, string, number]>(
            `UPDATE mail_messages SET unread = ?
             WHERE id = (SELECT message_id FROM mail_message_folders WHERE folder_id = ? AND uid = ?)`,
        ),
        unlink: sqlite.prepare<[string, number]>('DELETE FROM mail_message_folders WHERE folder_id = ? AND uid = ?'),
        /** 不再出现在任何文件夹中的邮件。 */
        orphans: sqlite.prepare<[string]>(
            `DELETE FROM mail_messages WHERE account_id = ?
             AND NOT EXISTS (SELECT 1 FROM mail_message_folders mf WHERE mf.message_id = mail_messages.id)`,
        ),
    };

    function threadKeyFor(accountId: string, m: MailMessageSync): string {
        for (const ref of [m.inReplyTo, ...m.references]) {
            if (!ref) continue;
            const found = q.byMessageId.get(accountId, ref);
            if (found) return found.threadKey;
        }
        if (m.messageId) {
            const like = `%${JSON.stringify(m.messageId).replace(/[%_\\]/g, '\\$&')}%`;
            const reply = q.replyTo.get(accountId, m.messageId, like);
            if (reply) return reply.threadKey;
        }
        return m.threadKey;
    }

    return {
        list(ownerId: string): MailAccountRecord[] {
            return q.list.all(ownerId).map(toAccount);
        },
        get(ownerId: string, id: string): MailAccountRecord | null {
            const row = q.get.get(ownerId, id);
            return row ? toAccount(row) : null;
        },
        create(ownerId: string, input: MailAccountCreate): MailAccountRecord {
            const id = newId(now());
            const sentCopy = explicitSentCopy(input) ?? 'auto';
            q.insert.run({
                id,
                ownerId,
                label: input.label,
                address: input.address,
                username: input.username,
                passwordRef: input.passwordRef,
                imap: JSON.stringify(input.imap),
                smtp: JSON.stringify(input.smtp),
                initialSyncDays: input.initialSyncDays,
                syncIntervalMinutes: input.syncIntervalMinutes,
                // 旧列只写不读(迁移 0011)
                appendToSent: sentCopy === 'off' ? 0 : 1,
                sentCopy,
                enabled: input.enabled ? 1 : 0,
                at: now().toISOString(),
            });
            return this.get(ownerId, id)!;
        },
        /** 修改配置后清掉退避状态,下一轮立即同步。 */
        update(ownerId: string, id: string, patch: MailAccountPatch): MailAccountRecord | null {
            const current = this.get(ownerId, id);
            if (!current) return null;
            const next = { ...current, ...patch, sentCopy: explicitSentCopy(patch) ?? current.sentCopy };
            q.update.run({
                id,
                label: next.label,
                address: next.address,
                username: next.username,
                passwordRef: next.passwordRef,
                imap: JSON.stringify(next.imap),
                smtp: JSON.stringify(next.smtp),
                initialSyncDays: next.initialSyncDays,
                syncIntervalMinutes: next.syncIntervalMinutes,
                appendToSent: next.sentCopy === 'off' ? 0 : 1,
                sentCopy: next.sentCopy,
                enabled: next.enabled ? 1 : 0,
                at: now().toISOString(),
            });
            return this.get(ownerId, id);
        },
        /** 删除账户:文件夹、邮件、附件索引、草稿经外键级联删除,mail_fts 由触发器清理。 */
        delete(ownerId: string, id: string): boolean {
            return q.delete.run(ownerId, id).changes > 0;
        },
        /** 已启用、到了同步时间的账户。 */
        due(at: Date): { ownerId: string; id: string }[] {
            return q.due.all(at.toISOString());
        },
        /** 记录一次同步的结果;失败时按指数退避推迟下一次(ADR 0016 第 2 节)。 */
        recordSync(
            id: string,
            result:
                | { ok: true; intervalMinutes: number; soon?: boolean }
                | { ok: false; error: string; intervalMinutes: number },
        ): void {
            const at = now();
            const failures = result.ok ? 0 : (q.failures.get(id)?.failures ?? 0) + 1;
            const delayMs = result.ok
                ? result.soon
                    ? 30_000
                    : result.intervalMinutes * 60_000
                : Math.min(result.intervalMinutes * 60_000 * 2 ** Math.min(failures - 1, 6), 6 * 3_600_000);
            q.record.run({
                id,
                syncedAt: result.ok ? at.toISOString() : null,
                error: result.ok ? null : result.error.slice(0, 500),
                failures,
                nextSyncAt: new Date(at.getTime() + delayMs).toISOString(),
            });
        },
        folders(accountId: string): MailFolder[] {
            return q.folders.all(accountId).map((f) => ({
                id: f.id,
                accountId,
                path: f.path,
                name: f.name,
                specialUse: (f.specialUse as MailFolder['specialUse']) ?? null,
                uidValidity: f.uidValidity,
                lastUid: f.lastUid,
                highestModseq: f.highestModseq,
                messageCount: f.messageCount,
                unreadCount: f.unreadCount,
                lastSyncedAt: f.lastSyncedAt,
            }));
        },
        /** 同步 worker 需要的已知状态。 */
        knownFolders(accountId: string): MailKnownFolder[] {
            return q.folders.all(accountId).map((f) => {
                const rows = q.folderUids.all(f.id);
                return {
                    path: f.path,
                    uidValidity: f.uidValidity,
                    lastUid: f.lastUid,
                    highestModseq: f.highestModseq,
                    uids: rows.map((r) => r.uid),
                    unreadUids: rows.filter((r) => r.unread === 1).map((r) => r.uid),
                };
            });
        },
        /** 在一个事务中写入一次同步的结果。 */
        applySync(accountId: string, folders: MailFolderSync[]): { added: number; updated: number; removed: number } {
            const at = now().toISOString();
            let added = 0;
            let updated = 0;
            return sqlite.transaction(() => {
                for (const folder of folders) {
                    let folderId = q.folderByPath.get(accountId, folder.path)?.id;
                    if (!folderId) {
                        folderId = newId(now());
                        q.insertFolder.run({
                            id: folderId,
                            accountId,
                            path: folder.path,
                            name: folder.name,
                            role: folder.role,
                        });
                    }
                    if (folder.reset) q.clearFolder.run(folderId);
                    for (const m of folder.messages) {
                        // 同一个 Message-ID 在账户内只保存一份,只记下它也出现在这个文件夹
                        const existing = m.messageId ? q.byMessageId.get(accountId, m.messageId) : undefined;
                        let id = existing?.id;
                        if (!id) {
                            id = newId(now());
                            q.insertMessage.run({
                                id,
                                accountId,
                                messageId: m.messageId,
                                inReplyTo: m.inReplyTo,
                                references: JSON.stringify(m.references),
                                threadKey: threadKeyFor(accountId, m),
                                from: m.from ? JSON.stringify(m.from) : null,
                                replyTo: JSON.stringify(m.replyTo),
                                to: JSON.stringify(m.to),
                                cc: JSON.stringify(m.cc),
                                subject: m.subject,
                                date: m.date,
                                unread: m.unread ? 1 : 0,
                                body: m.text,
                                snippet: snippetOf(m.text),
                                at,
                            });
                            for (const a of m.attachments) {
                                q.insertAttachment.run({ id: newId(now()), messageId: id, ...a });
                            }
                            added++;
                        }
                        q.link.run(folderId, m.uid, id);
                    }
                    for (const f of folder.flags) {
                        updated += q.setUnread.run(f.unread ? 1 : 0, folderId, f.uid).changes;
                    }
                    for (const uid of folder.deleted) q.unlink.run(folderId, uid);
                    q.updateFolder.run({
                        id: folderId,
                        name: folder.name,
                        role: folder.role,
                        uidValidity: folder.uidValidity,
                        lastUid: folder.lastUid,
                        highestModseq: folder.highestModseq,
                        at,
                    });
                }
                const removed = q.orphans.run(accountId).changes;
                return { added, updated, removed };
            })();
        },
    };
}
