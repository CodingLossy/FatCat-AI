// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ApprovalPreview } from '@fatcat-ai/shared';
import { useI18n } from '../i18n.js';
import { visibleText } from './sanitize.js';

export interface DiffLine {
    kind: 'add' | 'del' | 'ctx' | 'hunk';
    oldNo?: number;
    newNo?: number;
    text: string;
}

const HUNK = /^@@ -(\d+),\d+ \+(\d+),\d+ @@$/;

/** 把预览文本拆成带行号的行;未知前缀的行按上下文行处理,绝不当作可执行的东西。 */
export function parseDiff(text: string): DiffLine[] {
    const out: DiffLine[] = [];
    let oldNo = 0;
    let newNo = 0;
    for (const raw of text === '' ? [] : text.split('\n')) {
        const hunk = HUNK.exec(raw);
        if (hunk) {
            oldNo = Number(hunk[1]);
            newNo = Number(hunk[2]);
            out.push({ kind: 'hunk', text: raw });
        } else if (raw.startsWith('+')) out.push({ kind: 'add', newNo: newNo++, text: raw.slice(1) });
        else if (raw.startsWith('-')) out.push({ kind: 'del', oldNo: oldNo++, text: raw.slice(1) });
        else out.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
    }
    return out;
}

/** 没有 preview 时的退化:把新内容全部显示为新增行(只取 fs.write 的 content,按文本)。 */
export function addedLinesFrom(content: string, max = 500): DiffLine[] {
    return content
        .split(/\r\n|\n/)
        .slice(0, max)
        .map((text, i) => ({ kind: 'add' as const, newNo: i + 1, text }));
}

/**
 * 红绿 diff,只是显示:批准与否仍由旁边的审批按钮(现有的决定接口)决定,这里不能批准任何事。
 * 全部按文本节点渲染,不用 innerHTML。
 */
export function DiffView({
    preview,
    fallbackContent,
}: {
    preview?: ApprovalPreview | undefined;
    fallbackContent?: string;
}) {
    const { t } = useI18n();
    let lines: DiffLine[] = [];
    let note: string | null = null;
    if (preview) {
        if (preview.state === 'too-large') note = t('vis.diff.tooLarge');
        else if (preview.state === 'unchanged') note = t('vis.diff.unchanged');
        else lines = parseDiff(preview.text);
    } else if (typeof fallbackContent === 'string') {
        lines = addedLinesFrom(fallbackContent);
        note = t('vis.diff.noOld');
    } else return null;
    const label = preview ? (preview.state === 'created' ? t('vis.diff.created') : t('vis.diff.modified')) : null;
    return (
        <div className="diff-view" data-testid="diff-view">
            <div className="diff-head small">
                <span className="risk-tag">{t('vis.diff.risk')}</span>
                {preview ? <code>{visibleText(preview.path)}</code> : null}
                {label ? <span className="muted">{label}</span> : null}
            </div>
            {note ? <p className="small muted">{note}</p> : null}
            {lines.length > 0 ? (
                <div className="diff-body" role="table" aria-label="diff">
                    {lines.map((l, i) => (
                        <div key={i} className={`diff-ln ${l.kind}`} role="row">
                            <span className="diff-no">{l.oldNo ?? ''}</span>
                            <span className="diff-no">{l.newNo ?? ''}</span>
                            <span className="diff-mark">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
                            <span className="diff-text">{visibleText(l.text)}</span>
                        </div>
                    ))}
                </div>
            ) : null}
            {preview?.truncated ? <p className="small muted">{t('vis.diff.truncated')}</p> : null}
        </div>
    );
}
