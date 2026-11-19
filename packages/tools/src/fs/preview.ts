// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// fs.write 的审批预览(ADR 0046 第 12 节):按文件当前内容算出的有界行差异。只读、只用于显示。
import { openSync, closeSync, readSync, statSync } from 'node:fs';
import type { ApprovalPreview } from '@fatcat-ai/shared';
import { checkWritableTarget } from './paths.js';

/** 旧文件超过这个大小就不预览(显示「过大,无法预览」)。 */
export const PREVIEW_MAX_OLD_BYTES = 256 * 1024;
/** 两边各自的行数上限,保证 LCS 表有界(2000 × 2000)。 */
export const PREVIEW_MAX_LINES = 2000;
export const PREVIEW_MAX_OUTPUT_LINES = 500;
export const PREVIEW_MAX_OUTPUT_BYTES = 64 * 1024;
const CONTEXT = 3;

const splitLines = (text: string): string[] => {
    if (text === '') return [];
    const lines = text.split(/\r\n|\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
};

type Op = { t: ' ' | '-' | '+'; line: string };

/** 行级 LCS 差异;两边都不超过 PREVIEW_MAX_LINES 行。 */
export function diffLines(a: string[], b: string[]): Op[] {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const x = a.slice(start, endA);
    const y = b.slice(start, endB);
    const w = y.length + 1;
    const table = new Uint16Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
        for (let j = y.length - 1; j >= 0; j--) {
            table[i * w + j] =
                x[i] === y[j]
                    ? table[(i + 1) * w + j + 1]! + 1
                    : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
        }
    }
    const ops: Op[] = a.slice(0, start).map((line) => ({ t: ' ', line }));
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
        if (x[i] === y[j]) {
            ops.push({ t: ' ', line: x[i]! });
            i++;
            j++;
        } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) {
            ops.push({ t: '-', line: x[i++]! });
        } else {
            ops.push({ t: '+', line: y[j++]! });
        }
    }
    while (i < x.length) ops.push({ t: '-', line: x[i++]! });
    while (j < y.length) ops.push({ t: '+', line: y[j++]! });
    for (const line of a.slice(endA)) ops.push({ t: ' ', line });
    return ops;
}

/** 把差异整理成带 `@@ -旧起,旧行数 +新起,新行数 @@` 分段的文本,只保留改动周围 CONTEXT 行。 */
export function formatHunks(ops: Op[]): string[] {
    const keep = new Array<boolean>(ops.length).fill(false);
    ops.forEach((op, index) => {
        if (op.t === ' ') return;
        for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k++) keep[k] = true;
    });
    const out: string[] = [];
    let oldNo = 1;
    let newNo = 1;
    let index = 0;
    while (index < ops.length) {
        if (!keep[index]) {
            const op = ops[index]!;
            if (op.t !== '+') oldNo++;
            if (op.t !== '-') newNo++;
            index++;
            continue;
        }
        let end = index;
        while (end < ops.length && keep[end]) end++;
        const hunk = ops.slice(index, end);
        const oldCount = hunk.filter((o) => o.t !== '+').length;
        const newCount = hunk.filter((o) => o.t !== '-').length;
        out.push(`@@ -${oldNo},${oldCount} +${newNo},${newCount} @@`);
        for (const op of hunk) out.push(op.t + op.line);
        oldNo += oldCount;
        newNo += newCount;
        index = end;
    }
    return out;
}

function readOld(target: string): string | 'too-large' | null {
    let size: number;
    try {
        size = statSync(target).size;
    } catch {
        return null;
    }
    if (size > PREVIEW_MAX_OLD_BYTES) return 'too-large';
    const fd = openSync(target, 'r');
    try {
        const buffer = Buffer.alloc(size);
        const read = size > 0 ? readSync(fd, buffer, 0, size, 0) : 0;
        const slice = buffer.subarray(0, read);
        return slice.includes(0) ? 'too-large' : slice.toString('utf8');
    } finally {
        closeSync(fd);
    }
}

/**
 * 预览 `target`(已经过 resolveInRoots 校验的真实路径)被 `content` 替换后的样子。
 * 绝不读取 target 之外的东西;无法给出完整差异时用 state 说明,而不是把不完整的差异当作完整的。
 */
export function previewWrite(display: string, target: string, content: string): ApprovalPreview {
    const base = { kind: 'diff' as const, path: display.slice(0, 1024) };
    const tooLarge: ApprovalPreview = { ...base, state: 'too-large', text: '', truncated: false };
    const next = splitLines(content);
    if (next.length > PREVIEW_MAX_LINES) return tooLarge;
    const exists = checkWritableTarget(target) === 'file';
    let ops: Op[];
    let state: 'created' | 'modified' | 'unchanged';
    if (!exists) {
        state = 'created';
        ops = next.map((line) => ({ t: '+' as const, line }));
    } else {
        const old = readOld(target);
        if (old === 'too-large' || old === null) return tooLarge;
        const prev = splitLines(old);
        if (prev.length > PREVIEW_MAX_LINES) return tooLarge;
        ops = diffLines(prev, next);
        state =
            ops.every((o) => o.t === ' ') && old.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')
                ? 'unchanged'
                : 'modified';
    }
    const lines =
        state === 'created' ? ['@@ -0,0 +1,' + next.length + ' @@', ...ops.map((o) => '+' + o.line)] : formatHunks(ops);
    let truncated = false;
    let bytes = 0;
    const kept: string[] = [];
    for (const line of lines) {
        bytes += Buffer.byteLength(line) + 1;
        if (kept.length >= PREVIEW_MAX_OUTPUT_LINES || bytes > PREVIEW_MAX_OUTPUT_BYTES) {
            truncated = true;
            break;
        }
        kept.push(line);
    }
    return { ...base, state, text: kept.join('\n'), truncated };
}
