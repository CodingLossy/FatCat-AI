// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 「代码」面板(ADR 0049 第 4 节):项目、提交列表、差异与测试输出,全部来自本会话的工具调用。
// 面板不读文件、不调 git,也没有自己的批准按钮(审批仍在审批卡上)。所有文本都按文本节点渲染。
import { useEffect, useState } from 'react';
import { type CodeView, type CommitView, type GitDiffLine, relativeTo, type RunView, showFor } from './code-panel.js';
import { useI18n } from './i18n.js';
import { DiffView } from './visualizers/DiffView.js';

export function CodePanel({ view }: { view: CodeView }) {
    const { t } = useI18n();
    const [picked, setPicked] = useState<string | null>(null);
    const [asked, setAsked] = useState<string | null>(null);
    const pickedShow = picked ? showFor(view, picked) : null;
    // 新的结果到来时跟随最新的一项;用户点过的提交保留到下一次工具调用
    const [seen, setSeen] = useState(view.latest?.callId ?? null);
    if ((view.latest?.callId ?? null) !== seen) {
        setSeen(view.latest?.callId ?? null);
        setPicked(null);
        setAsked(null);
    }
    const current = pickedShow ?? view.latest;
    if (!view.project && !view.latest && !view.run) {
        return <p className="wb-empty">{t('codePanel.empty')}</p>;
    }
    return (
        <div className="code-panel" data-testid="code-panel">
            {view.project ? (
                <div className="code-project small">
                    <strong>{view.project.name}</strong>
                    <span className="muted"> · {view.project.path}</span>
                </div>
            ) : null}
            {view.commits.length > 0 ? (
                <section className="code-section" aria-label={t('codePanel.commits')}>
                    <h4>{t('codePanel.commits')}</h4>
                    <ul className="code-commits">
                        {view.commits.map((c) => {
                            const opened = showFor(view, c.hash) !== null;
                            const on = current?.kind === 'show' && current.view.sha?.startsWith(c.hash.toLowerCase());
                            return (
                                <li key={c.hash}>
                                    <button
                                        type="button"
                                        className={`code-commit${on ? ' on' : ''}`}
                                        aria-pressed={Boolean(on)}
                                        data-commit={c.hash}
                                        onClick={() => {
                                            if (opened) setPicked(c.hash);
                                            else setAsked(c.hash);
                                        }}
                                    >
                                        <span className="code-n">{c.n}</span>
                                        <code>{c.hash}</code>
                                        <span className="code-subject">{c.subject}</span>
                                        <span className="muted small">{c.author}</span>
                                    </button>
                                    {asked === c.hash ? (
                                        <p className="small muted code-ask" role="status">
                                            {t('codePanel.askToOpen', { n: c.n })}
                                        </p>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ) : null}
            {current ? (
                <section className="code-section" aria-label={t('codePanel.diff')}>
                    {current.kind === 'show' || current.kind === 'diff' ? (
                        <>
                            <h4>
                                {current.kind === 'show' ? t('codePanel.commit') : t('codePanel.workingDiff')}{' '}
                                <code className="muted">{current.title}</code>
                            </h4>
                            <GitDiff view={current.view} />
                        </>
                    ) : current.kind === 'write' ? (
                        <>
                            <h4>
                                {t('codePanel.editing')}{' '}
                                <code className="muted">
                                    {view.project ? relativeTo(current.path, view.project.path) : current.path}
                                </code>
                            </h4>
                            {current.tool.approval && !current.tool.approval.decision ? (
                                <p className="small muted">{t('codePanel.pendingWrite')}</p>
                            ) : null}
                            <DiffView
                                preview={current.tool.approval?.preview}
                                fallbackContent={contentOf(current.tool.input)}
                            />
                        </>
                    ) : (
                        <>
                            <h4>
                                {t('codePanel.file')}{' '}
                                <code className="muted">
                                    {view.project ? relativeTo(current.path, view.project.path) : current.path}
                                </code>
                            </h4>
                            <pre className="code-output">{current.text}</pre>
                            {current.clipped ? <p className="small muted">{t('codePanel.clipped')}</p> : null}
                        </>
                    )}
                </section>
            ) : null}
            {view.run ? <RunOutput key={view.run.callId} run={view.run} /> : null}
        </div>
    );
}

const contentOf = (input: unknown): string | undefined => {
    const c = (input as { content?: unknown } | null)?.content;
    return typeof c === 'string' ? c : undefined;
};

function GitDiff({ view }: { view: CommitView }) {
    const { t } = useI18n();
    return (
        <div className="diff-view code-diff" data-testid="code-diff">
            {view.header ? <pre className="code-header">{view.header}</pre> : null}
            {view.lines.length > 0 ? (
                <div className="diff-body" role="table" aria-label="diff">
                    {view.lines.map((l, i) => (
                        <DiffRow key={i} line={l} />
                    ))}
                </div>
            ) : (
                <p className="small muted code-note">{t('codePanel.noChanges')}</p>
            )}
            {view.clipped || view.omittedFiles.length > 0 ? (
                <p className="small muted code-note">
                    {t('codePanel.clipped')}
                    {view.omittedFiles.length > 0
                        ? ` ${t('codePanel.omitted', { files: view.omittedFiles.join(', ') })}`
                        : ''}
                </p>
            ) : null}
        </div>
    );
}

function DiffRow({ line }: { line: GitDiffLine }) {
    if (line.kind === 'file') {
        return (
            <div className="diff-ln file" role="row">
                <span className="diff-text">{line.text}</span>
            </div>
        );
    }
    if (line.kind === 'hunk' || line.kind === 'meta') {
        return (
            <div className={`diff-ln ${line.kind === 'hunk' ? 'hunk' : 'meta'}`} role="row">
                <span className="diff-text">{line.text}</span>
            </div>
        );
    }
    return (
        <div className={`diff-ln ${line.kind}`} role="row">
            <span className="diff-no">{line.oldNo ?? ''}</span>
            <span className="diff-no">{line.newNo ?? ''}</span>
            <span className="diff-mark">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
            <span className="diff-text">{line.text}</span>
        </div>
    );
}

/** 运行中的已用时间(秒):从面板第一次看到这次运行开始计(界面没有服务器的开始时间);按 callId 重新挂载归零。 */
function useElapsed(active: boolean): number {
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setSeconds((n) => n + 1), 1000);
        return () => window.clearInterval(timer);
    }, [active]);
    return seconds;
}

function RunOutput({ run }: { run: RunView }) {
    const { t } = useI18n();
    const elapsed = useElapsed(run.state === 'running');
    let status: string;
    if (run.state === 'waiting') status = t('codePanel.runWaiting', { command: run.command });
    else if (run.state === 'running') status = t('codePanel.running', { command: run.command, s: elapsed });
    else if (run.state === 'rejected') status = t('codePanel.runRejected', { command: run.command });
    else if (run.timedOut) status = t('codePanel.runTimedOut', { command: run.command });
    else if (run.cancelled) status = t('codePanel.runCancelled', { command: run.command });
    else if (run.exitCode === null && run.error) status = t('codePanel.runError', { command: run.command });
    else status = t('codePanel.runExit', { command: run.command, code: String(run.exitCode ?? '?') });
    return (
        <section
            className="code-section"
            aria-label={t('codePanel.output')}
            data-testid="code-run"
            data-state={run.state}
        >
            <h4>{t('codePanel.output')}</h4>
            <p className={`small code-run-status ${run.state}`} role="status">
                {status}
                {run.durationMs !== null
                    ? ` · ${t('codePanel.seconds', { s: (run.durationMs / 1000).toFixed(1) })}`
                    : ''}
            </p>
            {run.error ? <p className="error small">{run.error}</p> : null}
            {run.output ? <pre className="code-output">{run.output}</pre> : null}
            {run.clipped ? <p className="small muted">{t('codePanel.outputTail')}</p> : null}
        </section>
    );
}
