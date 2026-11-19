// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// RUNNING TOOLS 玻璃卡(ui-redesign.md 第 5 节):本轮运行的工具,数据来自现有 run 事件;最多 4 行。
import { Icon } from './Icon.js';
import { useI18n } from './i18n.js';
import type { LiveTool } from './live-turn.js';
import { runningRows, type RunningStatus } from './workbench.js';

function StatusMark({ status }: { status: RunningStatus }) {
    if (status === 'running') return <span className="rt-spinner" aria-hidden="true" />;
    if (status === 'done') return <Icon name="check" size={16} />;
    if (status === 'error') return <Icon name="x" size={16} />;
    return <Icon name="clock" size={16} />;
}

export function RunningTools({ tools }: { tools: readonly LiveTool[] }) {
    const { t } = useI18n();
    if (tools.length === 0) return null;
    const { rows, more } = runningRows(tools);
    return (
        <section className="running-tools" aria-label={t('wb.running')} data-testid="running-tools">
            <h2>{t('wb.running')}</h2>
            <ul>
                {rows.map((row) => (
                    <li key={row.callId} className={`rt-${row.status}`} data-status={row.status}>
                        <span
                            className="rt-mark"
                            title={t(`wb.status.${row.status}`)}
                            role="img"
                            aria-label={t(`wb.status.${row.status}`)}
                        >
                            <StatusMark status={row.status} />
                        </span>
                        <span className="rt-name">{row.name}</span>
                        {row.detail ? <span className="rt-detail">{row.detail}</span> : null}
                    </li>
                ))}
            </ul>
            {more > 0 ? <p className="small muted">{t('wb.runningMore', { n: more })}</p> : null}
        </section>
    );
}
