// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// characters 提供者:「人物」→ 每个联系人(ADR 0029 第 3、4 节)。联系人只来自已同步邮件的 From / To / Cc,不读正文。
// 人物到邮件用非 primary 的 mentions 边,每人最多链接最近的 200 封;非 primary 边不进计数。
import type { Item, ItemContent } from '@fatcat-ai/shared';
import { type ItemProvider, type SyncContext, textContent } from './provider.js';

export const CHARACTERS_ROOT_REF = 'characters';
/** 每个人物最多链接的邮件数(按邮件日期取最近的)。 */
export const MAX_MAILS_PER_CHARACTER = 200;
/** 一次同步最多读取的邮件数(最近的优先)。 */
const MAX_SCANNED_MESSAGES = 20_000;
const MAX_NAME_CHARS = 200;

interface Person {
    name: string | null;
    address: string;
}

export interface MailSample {
    /** 邮件 id(与 mail.message 条目 meta.messageId 一致)。 */
    id: string;
    date: string;
    from: Person | null;
    to: Person[];
    cc: Person[];
    /** 主人发出的邮件(位于「已发送」或发件人是本机账户)。 */
    sent: boolean;
    /** 带 List-Id 头的群发邮件。邮件缓存目前没有保存该头,调用方暂时都不置位(见 ADR 0029 实现说明)。 */
    listId?: boolean;
}

export interface Contact {
    address: string;
    name: string;
    mailCount: number;
    lastAt: string;
    /** 最近的邮件 id,新的在前,最多 MAX_MAILS_PER_CHARACTER 个。 */
    messageIds: string[];
}

/** 小写、去空白;不是 `local@domain` 形式时返回 null。 */
export function normalizeAddress(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const address = raw.trim().replace(/^<|>$/g, '').toLowerCase();
    if (address.length === 0 || address.length > 254) return null;
    return /^[^\s@<>()",;]+@[^\s@<>()",;]+$/.test(address) ? address : null;
}

const SYSTEM_LOCAL_PARTS = new Set([
    'noreply',
    'no-reply',
    'donotreply',
    'do-not-reply',
    'mailer-daemon',
    'postmaster',
    'notification',
    'notifications',
]);

/** 明显的系统发件地址:本地部分(最后一个 @ 之前)匹配,不分大小写。 */
export function isSystemAddress(address: string): boolean {
    return SYSTEM_LOCAL_PARTS.has(address.slice(0, address.lastIndexOf('@')).toLowerCase());
}

// 控制字符(C0、DEL、C1)与双向控制符(ALM、LRM / RLM、嵌入与覆盖、隔离)
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;

/** 显示名清洗:去掉控制与双向控制符,折叠空白,截断到 200 字符。 */
export function cleanDisplayName(name: string | null | undefined): string {
    if (!name) return '';
    return Array.from(name.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim())
        .slice(0, MAX_NAME_CHARS)
        .join('')
        .trim();
}

/**
 * 从邮件里识别联系人(纯函数)。算作联系人:主人发出过邮件的 To / Cc 收件人,
 * 以及来信不少于 2 封的发件人;排除本机地址、系统发件地址与 List-Id 群发邮件。
 */
export function detectContacts(messages: readonly MailSample[], ownAddresses: Iterable<string>): Contact[] {
    const own = new Set<string>();
    for (const a of ownAddresses) {
        const n = normalizeAddress(a);
        if (n) own.add(n);
    }
    const usable = messages.filter((m) => !m.listId).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const excluded = (address: string) => own.has(address) || isSystemAddress(address);

    const received = new Map<string, number>();
    const chosen = new Set<string>();
    for (const m of usable) {
        if (m.sent) {
            for (const r of [...m.to, ...m.cc]) {
                const address = normalizeAddress(r.address);
                if (address && !excluded(address)) chosen.add(address);
            }
        } else {
            const address = normalizeAddress(m.from?.address);
            if (address && !excluded(address)) received.set(address, (received.get(address) ?? 0) + 1);
        }
    }
    for (const [address, n] of received) if (n >= 2) chosen.add(address);

    // 按新到旧遍历:第一次遇到的非空显示名就是最近一次的
    const found = new Map<string, Contact>();
    for (const address of chosen) found.set(address, { address, name: '', mailCount: 0, lastAt: '', messageIds: [] });
    for (const m of usable) {
        const seen = new Set<string>();
        for (const p of [m.from, ...m.to, ...m.cc]) {
            if (!p) continue;
            const address = normalizeAddress(p.address);
            const contact = address ? found.get(address) : undefined;
            if (!address || !contact) continue;
            if (!seen.has(address)) {
                seen.add(address);
                contact.mailCount++;
                if (!contact.lastAt) contact.lastAt = m.date;
                if (contact.messageIds.length < MAX_MAILS_PER_CHARACTER) contact.messageIds.push(m.id);
            }
            if (!contact.name) contact.name = cleanDisplayName(p.name);
        }
    }
    return [...found.values()]
        .filter((c) => c.mailCount > 0)
        .map((c) => ({ ...c, name: c.name || c.address.slice(0, c.address.lastIndexOf('@')).slice(0, MAX_NAME_CHARS) }))
        .sort((a, b) => (a.address < b.address ? -1 : 1));
}

export const charactersProvider: ItemProvider = {
    id: 'characters',
    async sync(ctx: SyncContext) {
        const { repos, ownerId } = ctx;
        const accounts = repos.mail.list(ownerId);
        const existingRoot = repos.items.bySource(ownerId, 'characters', CHARACTERS_ROOT_REF);
        if (accounts.length === 0 && !existingRoot) return;
        // 邮件缓存没有变化时跳过(1 万封邮件也不会每次重算)
        const signature = `${accounts
            .map((a) => `${a.id}:${a.address}:${repos.mailCache.signature(a.id)}`)
            .join('|')}:v1`;
        const known = (existingRoot?.meta as { signature?: string } | null)?.signature;
        if (existingRoot && !existingRoot.deletedAt && known === signature) return;
        const root = ctx.upsert({
            sourceRef: CHARACTERS_ROOT_REF,
            kind: 'category',
            type: 'characters.root',
            title: '人物',
            icon: 'people',
            parentId: null,
        });

        const sentIds = new Set(
            repos.mailCache.list(ownerId, { folder: 'sent', limit: MAX_SCANNED_MESSAGES }).map((m) => m.id),
        );
        const own = accounts.map((a) => a.address);
        const ownSet = new Set(own.map((a) => a.toLowerCase()));
        const records = repos.mailCache.list(ownerId, { limit: MAX_SCANNED_MESSAGES });
        const folderOf = new Map(records.map((m) => [m.id, m.folderId]));
        const samples: MailSample[] = records.map((m) => ({
            id: m.id,
            date: m.date,
            from: m.from,
            to: m.to,
            cc: m.cc,
            sent: sentIds.has(m.id) || (m.from !== null && ownSet.has(m.from.address.toLowerCase())),
        }));

        const keep = new Set<string>();
        for (const c of detectContacts(samples, own)) {
            keep.add(c.address);
            const person = ctx.upsert({
                sourceRef: c.address,
                kind: 'content',
                type: 'character',
                title: c.name,
                summary: c.address,
                icon: 'person',
                meta: { address: c.address, mailCount: c.mailCount, lastContactAt: c.lastAt },
                parentId: root.id,
            });
            const targets: string[] = [];
            for (const id of c.messageIds) {
                const folderId = folderOf.get(id);
                const item = folderId ? repos.items.bySource(ownerId, 'mail', `message:${folderId}:${id}`) : null;
                if (item && !item.deletedAt) targets.push(item.id);
            }
            repos.items.relate(ownerId, person.id, 'mentions', targets);
        }
        ctx.removeMissing(root.id, keep);
        // 全部写完才记下指纹:中途失败时下次会重新同步
        ctx.upsert({
            sourceRef: CHARACTERS_ROOT_REF,
            kind: 'category',
            type: 'characters.root',
            title: '人物',
            icon: 'people',
            meta: { signature },
            parentId: null,
        });
    },

    /** 打开人物:只有显示名、地址、邮件数与最近往来时间(不含邮件正文)。 */
    async open(item: Item): Promise<ItemContent> {
        const meta = (item.meta ?? {}) as { address?: string; mailCount?: number; lastContactAt?: string };
        const lines = [item.title, meta.address, meta.mailCount === undefined ? '' : `${meta.mailCount} 封邮件`];
        return textContent([...lines, meta.lastContactAt ?? ''].filter(Boolean).join('\n'));
    },
};
