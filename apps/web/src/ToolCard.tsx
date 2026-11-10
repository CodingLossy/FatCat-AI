// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ApprovalWarning, KbSearchOutput } from '@fatcat-ai/shared';
import { useState } from 'react';
import { api, errorText } from './api.js';
import { ApprovalActions } from './ApprovalActions.js';
import { useI18n } from './i18n.js';
import type { LiveTool } from './live-turn.js';

export function show(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/**
 * 工具调用卡片;等待审批时显示「批准」「拒绝」与「记住」选项(ADR 0009 第 4 节、ADR 0010 第 3 节)。
 * 摘要与入参来自模型,一律按纯文本显示。
 */
/** 审批警告:有警告时整张卡片标红,逐条显示(文字由 core 生成)。 */
export function ApprovalWarnings({ warnings }: { warnings?: ApprovalWarning[] | undefined }) {
    const { t } = useI18n();
    if (!warnings?.length) return null;
    return (
        <div className="approval-warnings" role="alert">
            <strong>{t('approvals.warning')}</strong>
            <ul>
                {warnings.map((w) => (
                    <li key={w.code}>{w.message}</li>
                ))}
            </ul>
        </div>
    );
}

export function ToolCard({ tool, live = false }: { tool: LiveTool; live?: boolean }) {
    const { t } = useI18n();
    const pending = live && tool.approval && !tool.approval.decision;
    const resolved = tool.approval?.decision;

    return (
        <div
            className={`tool-card${pending ? ' pending' : ''}${pending && tool.approval?.warnings?.length ? ' warned' : ''}`}
            data-call-id={tool.callId}
        >
            <div className="tool-title">{t('tool.call', { name: tool.name })}</div>
            {tool.approval ? <p className="tool-summary">{tool.approval.summary}</p> : null}
            {pending ? <ApprovalWarnings warnings={tool.approval?.warnings} /> : null}
            <details>
                <summary className="small muted">input</summary>
                <pre>{show(tool.input)}</pre>
            </details>
            {pending ? (
                <ApprovalActions
                    callId={tool.callId}
                    risk={tool.approval?.risk}
                    toolName={tool.name}
                    input={tool.input}
                />
            ) : resolved ? (
                <p className="small decision">
                    {tool.approval?.reason === 'expired'
                        ? t('tool.expired')
                        : resolved === 'approve'
                          ? t('tool.approved')
                          : t('tool.rejected')}
                </p>
            ) : null}
            {tool.result ? (
                tool.result.error ? (
                    <p className="error small">{t('tool.error', { msg: tool.result.error })}</p>
                ) : (
                    <>
                        {tool.name === 'kb.search' ? <Citations output={tool.result.output} /> : null}
                        {MEMORY_WRITE_TOOLS.includes(tool.name) ? (
                            <RememberedNotice input={tool.input} output={tool.result.output} />
                        ) : null}
                        <details>
                            <summary className="small muted">{t('tool.result')}</summary>
                            <pre>{show(tool.result.output)}</pre>
                        </details>
                    </>
                )
            ) : null}
        </div>
    );
}

const MEMORY_WRITE_TOOLS = ['memory.write', 'memory.save'];

/**
 * 新写入的记忆(包括条件预授权直接写入的)显示「已记住:… [撤销]」,撤销即删除这条记忆(ADR 0010 第 4 节)。
 * 只对新建的记忆提供撤销;合并或更替的撤销需要恢复旧值,放在记忆页处理。
 */
function RememberedNotice({ input, output }: { input: unknown; output: unknown }) {
    const { t } = useI18n();
    const [undone, setUndone] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const result = output as { outcome?: unknown; id?: unknown } | null;
    const text = (input as { text?: unknown } | null)?.text;
    if (result?.outcome !== 'created' || typeof result.id !== 'string' || typeof text !== 'string') return null;
    const id = result.id;
    const undo = async () => {
        try {
            await api.memory.delete(id, 'undo');
            setUndone(true);
        } catch (e) {
            setError(errorText(e));
        }
    };
    return (
        <p className="small remembered" data-testid="remembered">
            {undone ? (
                t('memory.undone')
            ) : (
                <>
                    {t('memory.remembered', { text })}{' '}
                    <button type="button" className="link small" onClick={() => void undo()}>
                        {t('memory.undo')}
                    </button>
                </>
            )}
            {error ? <span className="error"> {error}</span> : null}
        </p>
    );
}

/** kb.search 的引用:文件名与页码(可点击跳转推迟,ADR 0015)。其他工具的输出不显示。 */
function Citations({ output }: { output: unknown }) {
    const { t } = useI18n();
    // 只用类型判断,不在浏览器里引入 zod
    const citations = (output as Partial<KbSearchOutput> | null)?.citations;
    if (!Array.isArray(citations) || citations.length === 0) return null;
    return (
        <ol className="citations small">
            {citations.map((c) => (
                <li key={c.n} title={c.path}>
                    {c.file}
                    {c.page ? ` · ${t('kb.page', { n: c.page })}` : ''}
                    {c.heading ? ` · ${c.heading}` : ''}
                </li>
            ))}
        </ol>
    );
}
