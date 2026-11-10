// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 本地假 IMAP 服务器(只读,TLS),给内存压测用(ADR 0018 第 4 节)。
// 只实现 imapflow 同步时用到的命令:LOGIN、ID、LIST、EXAMINE / SELECT、UID SEARCH、UID FETCH、LOGOUT。
// 邮件是按序号确定生成的合成邮件,不连外网,不用真实账户。
import { createServer } from 'node:tls';

const DAY = 86_400_000;
const WORDS = ['meeting', 'report', 'invoice', 'travel', 'project', 'update', 'review', 'budget', 'schedule', 'notes'];
const ZH = ['会议纪要', '项目进度', '报销单', '出差安排', '周报', '预算调整', '合同草稿', '客户反馈'];

/** 第 i 封邮件(1 起)的原文;正文 2–20 KB,中英混排。 */
function rawMessage(folder, i, now) {
    const date = new Date(now - ((i * 7919) % (20 * DAY)) - DAY);
    const word = WORDS[i % WORDS.length];
    const zh = ZH[i % ZH.length];
    const subject = `=?UTF-8?B?${Buffer.from(`${zh} ${word} #${i}`).toString('base64')}?=`;
    const para = `${zh}:这是第 ${i} 封合成邮件,用于内存压测。The ${word} for item ${i} is attached below. `;
    const body = para.repeat(20 + (i % 9) * 25);
    const from = folder === 'Sent' ? 'owner@example.test' : `sender${i % 300}@example.test`;
    const to = folder === 'Sent' ? `friend${i % 200}@example.test` : 'owner@example.test';
    const headers = [
        `Message-ID: <synthetic-${folder}-${i}@example.test>`,
        `Date: ${date.toUTCString()}`,
        `From: Sender ${i % 300} <${from}>`,
        `To: <${to}>`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
    ];
    if (i > 1 && i % 5 === 0) {
        headers.push(`In-Reply-To: <synthetic-${folder}-${i - 1}@example.test>`);
        headers.push(`References: <synthetic-${folder}-${i - 1}@example.test>`);
    }
    return { date, subject, from, to, bytes: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8') };
}

const quote = (s) => `"${String(s).replace(/["\\]/g, (c) => `\\${c}`)}"`;
const addr = (email) => {
    const [mailbox, host] = email.split('@');
    return `((NIL NIL ${quote(mailbox)} ${quote(host)}))`;
};
const imapDate = (d) => {
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    const pad = (n) => String(n).padStart(2, '0');
    return `"${pad(d.getUTCDate())}-${m}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000"`;
};

/** 解析 UID 集合("1,3,5:9"、"10:*");max 为当前最大 UID。 */
function uidSet(spec, max) {
    const out = new Set();
    for (const part of spec.split(',')) {
        const [a, b] = part.split(':');
        const lo = a === '*' ? max : Number(a);
        const hi = b === undefined ? lo : b === '*' ? max : Number(b);
        for (let u = Math.min(lo, hi); u <= Math.max(lo, hi) && u <= max; u++) if (u >= 1) out.add(u);
    }
    return [...out].sort((x, y) => x - y);
}

/**
 * 启动服务器。counts:每个文件夹的邮件数,如 `{ INBOX: 10000, Sent: 0 }`。
 * 返回 `{ port, close }`。
 */
export function startFakeImap({ key, cert, counts, now = Date.now() }) {
    const server = createServer({ key, cert, minVersion: 'TLSv1.2' }, (socket) => {
        let selected = null;
        let buffer = '';
        const send = (line) => socket.write(`${line}\r\n`);
        send('* OK [CAPABILITY IMAP4rev1 ID LITERAL+] fake-imap ready');

        function fetch(tag, uids, items) {
            const wantBody = /BODY\.PEEK\[\]/i.test(items);
            for (const uid of uids) {
                const m = rawMessage(selected, uid, now);
                const parts = [`UID ${uid}`, 'FLAGS ()'];
                if (/INTERNALDATE/i.test(items)) parts.push(`INTERNALDATE ${imapDate(m.date)}`);
                if (/ENVELOPE/i.test(items)) {
                    const id = `<synthetic-${selected}-${uid}@example.test>`;
                    parts.push(
                        `ENVELOPE (${quote(m.date.toUTCString())} ${quote(m.subject)} ${addr(m.from)} ${addr(m.from)} ${addr(m.from)} ${addr(m.to)} NIL NIL NIL ${quote(id)})`,
                    );
                }
                if (/BODYSTRUCTURE/i.test(items)) {
                    const lines = m.bytes.toString('utf8').split('\r\n').length;
                    parts.push(
                        `BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${m.bytes.length} ${lines} NIL NIL NIL NIL)`,
                    );
                }
                if (wantBody) {
                    socket.write(`* ${uid} FETCH (${parts.join(' ')} BODY[]<0> {${m.bytes.length}}\r\n`);
                    socket.write(m.bytes);
                    socket.write(')\r\n');
                } else {
                    send(`* ${uid} FETCH (${parts.join(' ')})`);
                }
            }
            send(`${tag} OK UID FETCH completed`);
        }

        function handle(line) {
            const match = /^(\S+)\s+(\S+)\s*(.*)$/.exec(line);
            if (!match) return;
            const [, tag, rawCmd, args] = match;
            let cmd = rawCmd.toUpperCase();
            let rest = args;
            if (cmd === 'UID') {
                const sub = /^(\S+)\s*(.*)$/.exec(args);
                cmd = `UID ${sub[1].toUpperCase()}`;
                rest = sub[2];
            }
            const max = selected ? (counts[selected] ?? 0) : 0;
            switch (cmd) {
                case 'CAPABILITY':
                    send('* CAPABILITY IMAP4rev1 ID LITERAL+');
                    return send(`${tag} OK CAPABILITY completed`);
                case 'LOGIN':
                    return send(`${tag} OK [CAPABILITY IMAP4rev1 ID LITERAL+] LOGIN completed`);
                case 'ID':
                    send('* ID ("name" "fake-imap")');
                    return send(`${tag} OK ID completed`);
                case 'NOOP':
                case 'CHECK':
                    return send(`${tag} OK done`);
                case 'LIST':
                case 'LSUB':
                    for (const name of Object.keys(counts)) {
                        const flags = name === 'Sent' ? '\\HasNoChildren \\Sent' : '\\HasNoChildren';
                        send(`* ${cmd} (${flags}) "/" ${quote(name)}`);
                    }
                    return send(`${tag} OK ${cmd} completed`);
                case 'EXAMINE':
                case 'SELECT': {
                    selected = rest.replace(/^"|"$/g, '');
                    const n = counts[selected] ?? 0;
                    send('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
                    send(`* ${n} EXISTS`);
                    send('* 0 RECENT');
                    send('* OK [UIDVALIDITY 7] UIDs valid');
                    send(`* OK [UIDNEXT ${n + 1}] next UID`);
                    return send(`${tag} OK [READ-ONLY] ${cmd} completed`);
                }
                case 'UID SEARCH':
                case 'SEARCH': {
                    let uids;
                    const uidArg = /UID\s+(\S+)/i.exec(rest);
                    if (uidArg) uids = uidSet(uidArg[1], max);
                    else uids = Array.from({ length: max }, (_, k) => k + 1); // SINCE:合成邮件都在最近 20 天内
                    send(`* SEARCH${uids.length ? ` ${uids.join(' ')}` : ''}`);
                    return send(`${tag} OK SEARCH completed`);
                }
                case 'UID FETCH': {
                    const sub = /^(\S+)\s+(.*)$/.exec(rest);
                    return fetch(tag, uidSet(sub[1], max), sub[2]);
                }
                case 'CLOSE':
                case 'UNSELECT':
                    selected = null;
                    return send(`${tag} OK ${cmd} completed`);
                case 'LOGOUT':
                    send('* BYE fake-imap closing');
                    send(`${tag} OK LOGOUT completed`);
                    return socket.end();
                default:
                    return send(`${tag} BAD unsupported command ${cmd}`);
            }
        }

        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            buffer += chunk;
            let i;
            while ((i = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, i);
                buffer = buffer.slice(i + 2);
                handle(line);
            }
        });
        socket.on('error', () => undefined);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () =>
            resolve({ port: server.address().port, close: () => new Promise((r) => server.close(() => r())) }),
        );
    });
}
