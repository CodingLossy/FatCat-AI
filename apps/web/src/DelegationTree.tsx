// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { RunTree } from '@fatcat-ai/shared';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useI18n } from './i18n.js';

/** 一个运行委派出去的子运行(ADR 0042 第 7 节):缩进显示代理名与状态;没有子运行时不显示。 */
export function DelegationTree({ runId, active }: { runId: string; active: boolean }) {
    const { t } = useI18n();
    const [tree, setTree] = useState<RunTree | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let alive = true;
        const load = () =>
            api.runs.tree(runId).then(
                (next) => {
                    if (!alive) return;
                    setTree(next);
                    setFailed(false);
                },
                () => alive && setFailed(true),
            );
        void load();
        // 运行中每 2 秒刷新一次状态
        const timer = active ? setInterval(() => void load(), 2000) : null;
        return () => {
            alive = false;
            if (timer) clearInterval(timer);
        };
    }, [runId, active]);

    if (failed && active) {
        return <p className="small muted">{t('agents.tree.unavailable')}</p>;
    }
    if (!tree || tree.nodes.length < 2) return null;
    return (
        <div className="delegation-tree card" data-testid="delegation-tree">
            <p className="small muted">{t('agents.tree.title')}</p>
            <ul className="list">
                {tree.nodes.map((node) => (
                    <li
                        key={node.runId}
                        style={{ marginLeft: `${node.depth * 1.2}rem` }}
                        data-status={node.status}
                        data-testid="tree-node"
                    >
                        <span>{node.agentName ?? t('agents.tree.main')}</span>{' '}
                        <span className={`badge tree-${node.status}`}>{t(`agents.tree.status.${node.status}`)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
