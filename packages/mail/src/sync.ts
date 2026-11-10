// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 一个账户的一次同步(ADR 0016 第 2 节):只读,只处理收件箱与已发送。
// 只依赖 ImapSession 接口,所以能用内存实现做单测;真正的 IMAP 连接在 client.ts。
import type { FolderResult, FolderRole, ImapSession, KnownFolder, SyncInput, SyncOutput } from './types.js';

export const DEFAULT_BATCH_SIZE = 200;

/** 服务器没有报告 special-use 时,按常见名称识别「已发送」。 */
const SENT_NAMES = ['sent', 'sent items', 'sent messages', 'sent mail', '已发送', '已发送邮件', '寄件備份'];

/** 选出要同步的文件夹:收件箱与已发送各一个。 */
export function pickFolders(
    folders: { path: string; name: string; specialUse: string | null }[],
): { path: string; name: string; role: FolderRole }[] {
    const inbox =
        folders.find((f) => f.specialUse?.toLowerCase() === '\\inbox') ??
        folders.find((f) => f.path.toUpperCase() === 'INBOX');
    const sent =
        folders.find((f) => f.specialUse?.toLowerCase() === '\\sent') ??
        folders.find((f) => SENT_NAMES.includes(f.name.trim().toLowerCase()));
    const picked: { path: string; name: string; role: FolderRole }[] = [];
    if (inbox) picked.push({ path: inbox.path, name: inbox.name, role: 'inbox' });
    if (sent && sent.path !== inbox?.path) picked.push({ path: sent.path, name: sent.name, role: 'sent' });
    return picked;
}

function emptyKnown(path: string): KnownFolder {
    return { path, uidValidity: null, lastUid: 0, highestModseq: null, uids: [], unreadUids: [] };
}

async function syncFolder(
    session: ImapSession,
    folder: { path: string; name: string; role: FolderRole },
    known: KnownFolder,
    input: SyncInput,
): Promise<FolderResult> {
    const info = await session.open(folder.path);
    const reset = known.uidValidity !== null && known.uidValidity !== info.uidValidity;
    const first = reset || known.uidValidity === null;
    const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;

    // 新邮件:首次只拉最近 N 天,之后只拉 UID 更大的
    let candidates: number[];
    if (first) {
        const since = new Date(Date.parse(input.now) - input.initialSyncDays * 86_400_000);
        candidates = await session.searchSince(since);
    } else {
        // "n:*" 在没有新邮件时也会返回最后一封,所以按 lastUid 过滤
        candidates = (await session.searchUids(`${known.lastUid + 1}:*`)).filter((uid) => uid > known.lastUid);
    }
    candidates.sort((a, b) => a - b);
    const take = candidates.slice(0, batchSize);
    const messages = take.length > 0 ? await session.fetchMessages(take) : [];
    const lastUid = take.length > 0 ? take[take.length - 1]! : first ? 0 : known.lastUid;

    // 已缓存的邮件:重新同步已读状态,发现服务器上的删除
    const flags: { uid: number; unread: boolean }[] = [];
    const deleted: number[] = [];
    if (!first && known.uids.length > 0) {
        const range = `${Math.min(...known.uids)}:${known.lastUid}`;
        const cached = new Set(known.uids);
        const unread = new Set(known.unreadUids);
        const present = new Set((await session.searchUids(range)).filter((uid) => cached.has(uid)));
        for (const uid of known.uids) if (!present.has(uid)) deleted.push(uid);
        const useModseq = known.highestModseq !== null && info.highestModseq !== null;
        if (!useModseq || known.highestModseq !== info.highestModseq) {
            const changed = await session.fetchFlags(range, useModseq ? known.highestModseq! : undefined);
            for (const f of changed) {
                if (present.has(f.uid) && unread.has(f.uid) !== f.unread) flags.push(f);
            }
        }
    }

    return {
        path: folder.path,
        name: folder.name,
        role: folder.role,
        uidValidity: info.uidValidity,
        highestModseq: info.highestModseq,
        reset,
        lastUid,
        messages,
        flags,
        deleted,
        more: candidates.length > take.length,
    };
}

export async function syncAccountWith(session: ImapSession, input: SyncInput): Promise<SyncOutput> {
    try {
        const picked = pickFolders(await session.listFolders());
        const folders: FolderResult[] = [];
        // 逐个文件夹处理,并发 1
        for (const folder of picked) {
            const known = input.folders.find((f) => f.path === folder.path) ?? emptyKnown(folder.path);
            folders.push(await syncFolder(session, folder, known, input));
        }
        return { folders };
    } finally {
        await session.close().catch(() => undefined);
    }
}
