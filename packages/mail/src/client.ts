// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 真正的网络连接:IMAP(imapflow)、邮件解析(mailparser)、SMTP(nodemailer)。
// 这些库加起来约占 35 MiB 内存,只在邮件子进程中加载,服务器进程不导入本文件(ADR 0016 第 2 节)。
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { MailAddress, MailConnectionTest, MailServer } from '@ai-personal/shared';
import { MailAddressString } from '@ai-personal/shared';
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import { createTransport } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { syncAccountWith } from './sync.js';
import type {
    DownloadInput,
    ImapConnectOptions,
    ImapSession,
    ParsedAttachment,
    ParsedMessage,
    SendInput,
    SendOutput,
    SyncInput,
    SyncOutput,
} from './types.js';

const CLIENT_INFO = { name: 'AI-Personal', vendor: 'AI-Personal' };
/** 每封邮件最多取前 1 MiB 原文来解析正文;附件索引来自 BODYSTRUCTURE,不受影响。 */
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const TIMEOUT_MS = 30_000;

function tlsOptions(server: MailServer, ca: string | undefined) {
    const host = server.host.replace(/^\[|\]$/g, '');
    // SNI 只能是主机名,不能是 IP 地址(RFC 6066)
    return { ...(isIP(host) ? {} : { servername: host }), minVersion: 'TLSv1.2' as const, ...(ca ? { ca } : {}) };
}

function newImapClient(options: ImapConnectOptions): ImapFlow {
    const { server } = options;
    return new ImapFlow({
        host: server.host.replace(/^\[|\]$/g, ''),
        port: server.port,
        secure: server.security === 'tls',
        // STARTTLS 必须成功,否则不发送凭据(ADR 0016 第 1 节:不支持明文连接)
        doSTARTTLS: server.security === 'starttls' ? true : undefined,
        auth: { user: options.username, pass: options.password },
        // 服务器支持 ID 时发送客户端信息;163 邮箱要求这一步,否则拒绝登录(Unsafe Login)
        clientInfo: CLIENT_INFO,
        tls: tlsOptions(server, options.ca),
        logger: false,
        disableAutoIdle: true,
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS * 2,
    });
}

/** 把库的错误变成人能看懂的说明;不包含密码(调用方还会再脱敏一次)。 */
export function describeError(error: unknown): string {
    const e = error as { code?: string; authenticationFailed?: boolean; responseText?: string; message?: string };
    const text = `${e.responseText ?? ''} ${e.message ?? ''}`;
    if (/unsafe login/i.test(text)) {
        return 'The server refused the login as unsafe. For 163 mail, enable IMAP and use the client authorization code.';
    }
    if (e.authenticationFailed || /auth|login|credentials|password/i.test(e.code ?? '') || e.code === 'EAUTH') {
        return 'Login failed. Check the user name and use the app password or authorization code, not the account password.';
    }
    switch (e.code) {
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return 'The server name could not be resolved. Check the host.';
        case 'ECONNREFUSED':
            return 'The server refused the connection. Check the host and port.';
        case 'ETIMEDOUT':
        case 'CONNECT_TIMEOUT':
        case 'GREETING_TIMEOUT':
        case 'ETIMEOUT':
            return 'The server did not respond in time.';
        case 'ESOCKET':
        case 'ECONNECTION':
            return 'Could not connect to the server. Check the host, port and encryption setting.';
        default:
            break;
    }
    if (/certificate|self.signed|CERT_|unable to verify/i.test(text)) {
        return 'The server certificate could not be verified.';
    }
    if (/STARTTLS/i.test(text)) return 'The server does not offer STARTTLS on this port.';
    return `Mail server error: ${(e.responseText ?? e.message ?? String(error)).slice(0, 300)}`;
}

function addresses(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
    const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
    const out: MailAddress[] = [];
    for (const group of list) {
        for (const entry of group.value) {
            // 地址组(group)展开成成员
            for (const a of entry.group ?? [entry]) {
                const address = (a.address ?? '').trim();
                if (!MailAddressString.safeParse(address).success) continue;
                out.push({ name: a.name ? a.name.slice(0, 200) : null, address });
            }
        }
    }
    return out;
}

function stripBrackets(id: string): string {
    return id.trim().replace(/^<|>$/g, '').slice(0, 1000);
}

function referenceList(value: string | string[] | undefined): string[] {
    const list = value === undefined ? [] : Array.isArray(value) ? value : value.split(/\s+/);
    return list
        .filter((r) => r.trim() !== '')
        .map(stripBrackets)
        .slice(0, 500);
}

/** 从 BODYSTRUCTURE 中找出附件(只要索引,不下载内容)。 */
export function attachmentsOf(node: MessageStructureObject | undefined): ParsedAttachment[] {
    const out: ParsedAttachment[] = [];
    const walk = (n: MessageStructureObject) => {
        if (n.childNodes?.length) {
            for (const child of n.childNodes) walk(child);
            return;
        }
        const filename = n.dispositionParameters?.filename ?? n.parameters?.name;
        if (n.disposition === 'attachment' || filename) {
            out.push({
                part: n.part ?? '1',
                filename: (filename ?? 'attachment').slice(0, 500),
                contentType: n.type.slice(0, 200),
                size: n.size ?? 0,
            });
        }
    };
    if (node) walk(node);
    return out;
}

export async function parseFetched(message: FetchMessageObject): Promise<ParsedMessage> {
    const parsed = await simpleParser(message.source ?? Buffer.alloc(0), {
        skipImageLinks: true,
        skipTextToHtml: true,
        skipTextLinks: true,
    });
    const text = (parsed.text ?? '').slice(0, MAX_TEXT_CHARS);
    const from = addresses(parsed.from)[0] ?? null;
    const envelopeDate = message.envelope?.date ? new Date(message.envelope.date) : null;
    const date = parsed.date ?? envelopeDate ?? (message.internalDate ? new Date(message.internalDate) : new Date());
    const messageId = parsed.messageId ?? message.envelope?.messageId;
    const inReplyTo = parsed.inReplyTo ?? message.envelope?.inReplyTo;
    return {
        uid: message.uid,
        messageId: messageId ? stripBrackets(messageId) : null,
        inReplyTo: inReplyTo ? stripBrackets(inReplyTo.split(/\s+/)[0] ?? inReplyTo) : null,
        references: referenceList(parsed.references),
        from,
        replyTo: addresses(parsed.replyTo),
        to: addresses(parsed.to),
        cc: addresses(parsed.cc),
        subject: (parsed.subject ?? message.envelope?.subject ?? '').slice(0, 2000),
        date: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
        unread: !(message.flags?.has('\\Seen') ?? false),
        text,
        attachments: attachmentsOf(message.bodyStructure),
    };
}

/** imapflow 实现的只读会话。 */
export async function openImapSession(options: ImapConnectOptions): Promise<ImapSession> {
    const client = newImapClient(options);
    client.on('error', () => undefined);
    await client.connect();
    let release: (() => void) | null = null;
    const list = async (range: string) => (await client.search({ uid: range }, { uid: true })) || [];
    return {
        async listFolders() {
            return (await client.list()).map((f) => ({ path: f.path, name: f.name, specialUse: f.specialUse ?? null }));
        },
        async open(path) {
            release?.();
            const lock = await client.getMailboxLock(path, { readOnly: true });
            release = () => lock.release();
            const mailbox = client.mailbox;
            if (!mailbox) throw new Error(`could not open ${path}`);
            const condstore = client.enabled.has('CONDSTORE') && !mailbox.noModseq;
            return {
                uidValidity: Number(mailbox.uidValidity),
                highestModseq: condstore && mailbox.highestModseq !== undefined ? String(mailbox.highestModseq) : null,
            };
        },
        async searchSince(since) {
            return (await client.search({ since }, { uid: true })) || [];
        },
        searchUids: list,
        async fetchFlags(range, changedSince) {
            const out: { uid: number; unread: boolean }[] = [];
            for await (const m of client.fetch(
                range,
                { uid: true, flags: true },
                { uid: true, ...(changedSince ? { changedSince: BigInt(changedSince) } : {}) },
            )) {
                out.push({ uid: m.uid, unread: !(m.flags?.has('\\Seen') ?? false) });
            }
            return out;
        },
        async fetchMessages(uids) {
            const out: ParsedMessage[] = [];
            if (uids.length === 0) return out;
            // 取原文用 BODY.PEEK,不会把服务器上的邮件标为已读
            for await (const m of client.fetch(
                uids.join(','),
                {
                    uid: true,
                    flags: true,
                    envelope: true,
                    bodyStructure: true,
                    internalDate: true,
                    source: { start: 0, maxLength: MAX_SOURCE_BYTES },
                },
                { uid: true },
            )) {
                out.push(await parseFetched(m));
            }
            return out;
        },
        async close() {
            release?.();
            await client.logout().catch(() => client.close());
        },
    };
}

export async function syncAccount(input: SyncInput): Promise<SyncOutput> {
    return syncAccountWith(await openImapSession(input), input);
}

function smtpTransport(smtp: ImapConnectOptions) {
    return createTransport({
        host: smtp.server.host.replace(/^\[|\]$/g, ''),
        port: smtp.server.port,
        secure: smtp.server.security === 'tls',
        // STARTTLS 必须成功,否则不发送凭据
        requireTLS: smtp.server.security === 'starttls',
        auth: { user: smtp.username, pass: smtp.password },
        tls: tlsOptions(smtp.server, smtp.ca),
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
        logger: false,
    });
}

/** 附件合计大小上限:多数邮箱的单封上限在 20–50 MB 之间。 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const TOO_LARGE = 'The attachments are larger than 20 MB in total.';

async function readStream(stream: AsyncIterable<unknown>, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buf.length;
        if (size > limit) throw new Error(TOO_LARGE);
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}

async function connectImap(options: ImapConnectOptions): Promise<ImapFlow> {
    const client = newImapClient(options);
    client.on('error', () => undefined);
    await client.connect();
    return client;
}

/**
 * 发送一封邮件(ADR 0016 第 6 节):先组装原文,经 SMTP 发出,再按需 APPEND 到「已发送」并标为已读。
 * APPEND 失败不影响发送结果,只在返回值中说明。
 */
export async function sendMail(input: SendInput): Promise<SendOutput> {
    let budget = MAX_ATTACHMENT_BYTES;
    const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];
    let imap: ImapFlow | null = null;
    try {
        for (const a of input.mailAttachments) {
            imap ??= await connectImap(input.imap);
            const lock = await imap.getMailboxLock(a.folderPath, { readOnly: true });
            try {
                const download = await imap.download(String(a.uid), a.part, { uid: true, maxBytes: budget + 1 });
                if (!download.content) throw new Error(`The attachment ${a.filename} is no longer on the server.`);
                const content = await readStream(download.content, budget);
                budget -= content.length;
                attachments.push({ filename: a.filename, content, contentType: a.contentType });
            } finally {
                lock.release();
            }
        }
        for (const f of input.fileAttachments) {
            if ((await stat(f.path)).size > budget) throw new Error(TOO_LARGE);
            const content = await readFile(f.path);
            budget -= content.length;
            attachments.push({ filename: f.filename, content });
        }
        const node = new MailComposer({
            from: input.from.name ? { name: input.from.name, address: input.from.address } : input.from.address,
            to: input.to,
            cc: input.cc,
            subject: input.subject,
            text: input.text,
            ...(input.inReplyTo ? { inReplyTo: `<${input.inReplyTo}>` } : {}),
            ...(input.references.length ? { references: input.references.map((r) => `<${r}>`) } : {}),
            attachments,
        }).compile();
        const raw = await node.build();
        const transport = smtpTransport(input.smtp);
        let info: { accepted: unknown[]; rejected: unknown[] };
        try {
            info = await transport.sendMail({
                envelope: { from: input.from.address, to: [...input.to, ...input.cc] },
                raw,
            });
        } finally {
            transport.close();
        }
        const result: SendOutput = {
            messageId: node.messageId().replace(/^<|>$/g, ''),
            accepted: info.accepted.map(String),
            rejected: info.rejected.map(String),
            appended: false,
            appendError: null,
        };
        if (input.appendTo) {
            try {
                imap ??= await connectImap(input.imap);
                await imap.append(input.appendTo, raw, ['\\Seen']);
                result.appended = true;
            } catch (error) {
                result.appendError = describeError(error);
            }
        }
        return result;
    } finally {
        if (imap) await imap.logout().catch(() => imap?.close());
    }
}

/** 下载一个附件(只读打开文件夹;不会把邮件标为已读)。 */
export async function downloadAttachment(input: DownloadInput): Promise<Uint8Array> {
    const imap = await connectImap(input.imap);
    try {
        const lock = await imap.getMailboxLock(input.folderPath, { readOnly: true });
        try {
            const download = await imap.download(String(input.uid), input.part, {
                uid: true,
                maxBytes: input.maxBytes + 1,
            });
            if (!download.content) throw new Error('The attachment is no longer on the server.');
            return new Uint8Array(await readStream(download.content, input.maxBytes));
        } finally {
            lock.release();
        }
    } finally {
        await imap.logout().catch(() => imap.close());
    }
}

/** 分别测试 IMAP 登录与 SMTP 登录;不发送任何邮件。 */
export async function testConnection(imap: ImapConnectOptions, smtp: ImapConnectOptions): Promise<MailConnectionTest> {
    const result: MailConnectionTest = { imap: { ok: false, error: null }, smtp: { ok: false, error: null } };
    try {
        const session = await openImapSession(imap);
        await session.listFolders();
        await session.close();
        result.imap.ok = true;
    } catch (error) {
        result.imap.error = describeError(error);
    }
    const transport = smtpTransport(smtp);
    try {
        await transport.verify();
        result.smtp.ok = true;
    } catch (error) {
        result.smtp.error = describeError(error);
    } finally {
        transport.close();
    }
    return result;
}
