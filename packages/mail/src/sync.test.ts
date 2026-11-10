// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { pickFolders, syncAccountWith } from './sync.js';
import { ownThreadKey, subjectKey } from './thread.js';
import type { ImapSession, KnownFolder, ParsedMessage, SyncInput } from './types.js';

interface FakeMessage {
    uid: number;
    date: string;
    unread: boolean;
    modseq: number;
}

/** 内存中的 IMAP 服务器:记录被取过正文的 UID,以检查只拉需要的邮件。 */
function fakeServer(options: { condstore: boolean }) {
    const state = {
        uidValidity: 1,
        modseq: 10,
        folders: new Map<string, FakeMessage[]>([
            ['INBOX', []],
            ['已发送', []],
            ['Junk', []],
        ]),
        fetched: [] as number[],
        closed: 0,
    };
    const inRange = (range: string, uid: number) => {
        const [lo, hi] = range.split(':');
        const max = Math.max(0, ...[...state.folders.values()].flat().map((m) => m.uid));
        return uid >= Number(lo) && uid <= (hi === '*' ? Math.max(max, Number(lo)) : Number(hi));
    };
    let current: FakeMessage[] = [];
    const session: ImapSession = {
        listFolders: async () => [
            { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
            { path: '已发送', name: '已发送', specialUse: null },
            { path: 'Junk', name: 'Junk', specialUse: '\\Junk' },
        ],
        open: async (path) => {
            current = state.folders.get(path)!;
            return { uidValidity: state.uidValidity, highestModseq: options.condstore ? String(state.modseq) : null };
        },
        searchSince: async (since) => current.filter((m) => Date.parse(m.date) >= since.getTime()).map((m) => m.uid),
        searchUids: async (range) => {
            const hits = current.filter((m) => inRange(range, m.uid)).map((m) => m.uid);
            // 与真实服务器一样:"n:*" 没有命中时返回最后一封
            if (hits.length === 0 && range.endsWith(':*') && current.length) return [current[current.length - 1]!.uid];
            return hits;
        },
        fetchFlags: async (range, changedSince) =>
            current
                .filter((m) => inRange(range, m.uid) && (changedSince === undefined || m.modseq > Number(changedSince)))
                .map((m) => ({ uid: m.uid, unread: m.unread })),
        fetchMessages: async (uids) => {
            state.fetched.push(...uids);
            return uids.map((uid): ParsedMessage => ({
                uid,
                messageId: `m${uid}@x`,
                inReplyTo: null,
                references: [],
                from: null,
                replyTo: [],
                to: [],
                cc: [],
                subject: `s${uid}`,
                date: current.find((m) => m.uid === uid)!.date,
                unread: current.find((m) => m.uid === uid)!.unread,
                text: '',
                attachments: [],
            }));
        },
        close: async () => {
            state.closed++;
        },
    };
    const add = (uid: number, daysAgo: number, folder = 'INBOX') =>
        state.folders.get(folder)!.push({
            uid,
            date: new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString(),
            unread: true,
            modseq: ++state.modseq,
        });
    const touch = (uid: number, unread: boolean) => {
        const m = state.folders.get('INBOX')!.find((x) => x.uid === uid)!;
        m.unread = unread;
        m.modseq = ++state.modseq;
    };
    const remove = (uid: number) => {
        const inbox = state.folders.get('INBOX')!;
        inbox.splice(
            inbox.findIndex((m) => m.uid === uid),
            1,
        );
        state.modseq++;
    };
    return { state, session, add, touch, remove };
}

const NOW = '2026-11-05T08:00:00.000Z';

/** 模拟主线程:把同步结果写回「已知状态」。 */
function apply(known: KnownFolder[], result: Awaited<ReturnType<typeof syncAccountWith>>): KnownFolder[] {
    return result.folders.map((f) => {
        const prev = known.find((k) => k.path === f.path);
        const uids = new Set(f.reset ? [] : (prev?.uids ?? []));
        const unread = new Set(f.reset ? [] : (prev?.unreadUids ?? []));
        for (const m of f.messages) {
            uids.add(m.uid);
            if (m.unread) unread.add(m.uid);
        }
        for (const x of f.flags) {
            if (x.unread) unread.add(x.uid);
            else unread.delete(x.uid);
        }
        for (const uid of f.deleted) {
            uids.delete(uid);
            unread.delete(uid);
        }
        return {
            path: f.path,
            uidValidity: f.uidValidity,
            lastUid: f.lastUid,
            highestModseq: f.highestModseq,
            uids: [...uids].sort((a, b) => a - b),
            unreadUids: [...unread].sort((a, b) => a - b),
        };
    });
}

const input = (folders: KnownFolder[], over: Partial<SyncInput> = {}): SyncInput => ({
    server: { host: 'imap.example.com', port: 993, security: 'tls' },
    username: 'me',
    password: 'pw',
    initialSyncDays: 30,
    now: NOW,
    folders,
    ...over,
});

describe.each([{ condstore: true }, { condstore: false }])('同步(CONDSTORE: $condstore)', (options) => {
    it('首次只拉最近 30 天;之后只拉新 UID;已读变化与服务器删除都能发现;UIDVALIDITY 变化时重建', async () => {
        const s = fakeServer(options);
        s.add(1, 40);
        s.add(2, 10);
        s.add(3, 1);
        s.add(4, 2, '已发送');

        let r = await syncAccountWith(s.session, input([]));
        expect(r.folders.map((f) => [f.path, f.role])).toEqual([
            ['INBOX', 'inbox'],
            ['已发送', 'sent'],
        ]);
        expect(s.state.fetched).toEqual([2, 3, 4]);
        let known = apply([], r);
        expect(s.state.closed).toBe(1);

        // 没有新邮件、没有变化:不再取正文
        s.state.fetched = [];
        r = await syncAccountWith(s.session, input(known));
        expect(s.state.fetched).toEqual([]);
        expect(r.folders[0]).toMatchObject({ flags: [], deleted: [], messages: [] });

        // 新邮件、已读变化、删除
        s.add(5, 0);
        s.touch(2, false);
        s.remove(3);
        r = await syncAccountWith(s.session, input(known));
        expect(s.state.fetched).toEqual([5]);
        expect(r.folders[0]).toMatchObject({ flags: [{ uid: 2, unread: false }], deleted: [3], lastUid: 5 });
        known = apply(known, r);
        expect(known[0]).toMatchObject({ uids: [2, 5], unreadUids: [5] });

        // UIDVALIDITY 变化
        s.state.uidValidity = 2;
        s.state.fetched = [];
        r = await syncAccountWith(s.session, input(known));
        expect(r.folders[0]).toMatchObject({ reset: true, deleted: [], flags: [] });
        expect(s.state.fetched).toEqual([2, 5, 4]);
    });
});

describe('同步的其他规则', () => {
    it('每个文件夹每次最多拉一批,剩下的标记 more', async () => {
        const s = fakeServer({ condstore: false });
        for (let uid = 1; uid <= 5; uid++) s.add(uid, 1);
        const r = await syncAccountWith(s.session, input([], { batchSize: 2 }));
        expect(r.folders[0]).toMatchObject({ lastUid: 2, more: true });
        const next = await syncAccountWith(s.session, input(apply([], r), { batchSize: 2 }));
        expect(next.folders[0]).toMatchObject({ lastUid: 4, more: true });
    });

    it('出错时也会断开连接', async () => {
        const s = fakeServer({ condstore: false });
        s.session.open = async () => {
            throw new Error('boom');
        };
        await expect(syncAccountWith(s.session, input([]))).rejects.toThrow('boom');
        expect(s.state.closed).toBe(1);
    });

    it('只选收件箱与已发送;没有 special-use 时按名称识别', () => {
        expect(
            pickFolders([
                { path: 'INBOX', name: 'INBOX', specialUse: null },
                { path: '[Gmail]/All Mail', name: 'All Mail', specialUse: '\\All' },
                { path: 'Sent Messages', name: 'Sent Messages', specialUse: null },
            ]).map((f) => f.role),
        ).toEqual(['inbox', 'sent']);
    });

    it('会话串键:引用链优先;没有时按规范化主题与参与者', () => {
        const people = ['A@x.com', 'b@x.com'];
        expect(subjectKey('回复: Re:  周报 ', people)).toBe(subjectKey('周报', ['b@x.com', 'a@x.com']));
        expect(subjectKey('ＲＥ：周报', people)).toBe(subjectKey('周报', people));
        expect(ownThreadKey({ references: ['root@x'], inReplyTo: 'p@x', subject: 'x', participants: [] })).toBe(
            ownThreadKey({ references: [], inReplyTo: 'root@x', subject: 'y', participants: [] }),
        );
    });
});
