// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 会话串的键(ADR 0016 第 4 节)。优先用 References / In-Reply-To;存储层在写入时
// 再查找已缓存的相关邮件并沿用它们的键,这里只给出没有可沿用的键时的取值。
import { createHash } from 'node:crypto';

const PREFIX = /^\s*((re|fw|fwd|aw|wg|回复|答复|转发|回覆|轉寄)\s*(\[\d+\])?\s*[:：]\s*)+/i;

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** 去掉 Re: / Fwd: / 回复: 等前缀,全角转半角,压缩空白,转小写。 */
export function normalizeSubject(subject: string): string {
    const halfWidth = subject.normalize('NFKC');
    return halfWidth.replace(PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 按引用链的根(References 的第一个,其次 In-Reply-To)。 */
export function referenceKey(rootMessageId: string): string {
    return `r:${hash(rootMessageId.trim().toLowerCase())}`;
}

/** 没有引用头时:规范化主题 + 参与者(小写地址集合)。 */
export function subjectKey(subject: string, participants: string[]): string {
    const people = [...new Set(participants.map((p) => p.trim().toLowerCase()))].sort();
    return `s:${hash(`${normalizeSubject(subject)}\n${people.join(',')}`)}`;
}

/** 一封邮件自己能算出的键:有引用头时用引用链的根,否则按主题与参与者。 */
export function ownThreadKey(message: {
    references: string[];
    inReplyTo: string | null;
    subject: string;
    participants: string[];
}): string {
    const root = message.references[0] ?? message.inReplyTo;
    return root ? referenceKey(root) : subjectKey(message.subject, message.participants);
}
