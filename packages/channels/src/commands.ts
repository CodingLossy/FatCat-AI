// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// IM 里的指令(ADR 0022 第 3、4、6 节)。整条消息去掉首尾空白后完全匹配才算,避免误触;
// 全角字符(数字、字母、空格、斜杠)先按 NFKC 归一。

export type ChannelCommand =
    | { type: 'bind'; code: string }
    | { type: 'approval'; decision: 'approve' | 'reject'; code: string }
    | { type: 'new' }
    | { type: 'clear' }
    | { type: 'source' }
    | { type: 'help' };

/** 全角转半角、去掉首尾空白、连续空白合并为一个空格。 */
export function normalizeCommandText(text: string): string {
    return text.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

const BIND = /^(?:绑定|bind) ?(\d{6})$/i;
const APPROVAL = /^(确认|拒绝|approve|deny) ?([a-z]\d)$/i;
const SLASH: Record<string, ChannelCommand> = {
    '/new': { type: 'new' },
    '/clear': { type: 'clear' },
    '/source': { type: 'source' },
    '/help': { type: 'help' },
};

/** 识别指令;不是指令时返回 null(按普通消息交给模型)。 */
export function parseCommand(text: string): ChannelCommand | null {
    const t = normalizeCommandText(text);
    const bind = BIND.exec(t);
    if (bind) return { type: 'bind', code: bind[1]! };
    const approval = APPROVAL.exec(t);
    if (approval) {
        const verb = approval[1]!.toLowerCase();
        return {
            type: 'approval',
            decision: verb === '确认' || verb === 'approve' ? 'approve' : 'reject',
            code: approval[2]!.toUpperCase(),
        };
    }
    if (t === '清空') return { type: 'clear' };
    return SLASH[t.toLowerCase()] ?? null;
}

/** 审批短码:1 个字母 + 1 位数字,去掉易混的 I、O、0、1(ADR 0022 第 6 节)。 */
export const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_DIGITS = '23456789';

/** 分配一个不在 taken 里的短码;全部用完时返回 null(192 个,同时待审批的调用远少于此)。 */
export function allocateApprovalCode(taken: ReadonlySet<string>, random: () => number = Math.random): string | null {
    const total = CODE_LETTERS.length * CODE_DIGITS.length;
    const start = Math.floor(random() * total);
    for (let i = 0; i < total; i++) {
        const n = (start + i) % total;
        const code = `${CODE_LETTERS[Math.floor(n / CODE_DIGITS.length)]!}${CODE_DIGITS[n % CODE_DIGITS.length]!}`;
        if (!taken.has(code)) return code;
    }
    return null;
}
