// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ToolInfo, ToolRisk } from '@fatcat-ai/shared';
import { useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { canRemember, rememberConstraint } from './remember.js';

type Remember = '' | 'session' | 'always';

let toolsPromise: Promise<ToolInfo[]> | null = null;
/** 工具列表在页面中只取一次。 */
function loadTools(): Promise<ToolInfo[]> {
    toolsPromise ??= api.tools
        .list()
        .then((page) => page.items)
        .catch(() => {
            toolsPromise = null;
            return [];
        });
    return toolsPromise;
}

/** 审批按钮:批准 / 拒绝,批准时可选「记住」(仅本次 / 本会话 / 永久)。聊天卡片与全局审批面板共用。 */
export function ApprovalActions({
    callId,
    risk,
    toolName,
    input,
    onDecided,
}: {
    callId: string;
    risk: ToolRisk | undefined;
    toolName: string;
    input: unknown;
    onDecided?: () => void;
}) {
    const { t } = useI18n();
    const [busy, setBusy] = useState(false);
    const [remember, setRemember] = useState<Remember>('');
    const [error, setError] = useState<string | null>(null);
    const [info, setInfo] = useState<ToolInfo | undefined>(undefined);

    useEffect(() => {
        let alive = true;
        void loadTools().then((tools) => alive && setInfo(tools.find((x) => x.name === toolName)));
        return () => {
            alive = false;
        };
    }, [toolName]);

    const constraint = rememberConstraint(info, input);
    const rememberable = canRemember(risk) && constraint !== null;
    const scope = constraint?.domain
        ? ` (${constraint.domain})`
        : constraint?.pathPrefix
          ? ` (${constraint.pathPrefix})`
          : '';

    const decide = async (decision: 'approve' | 'reject') => {
        setBusy(true);
        setError(null);
        try {
            const choice =
                decision === 'approve' && remember && rememberable
                    ? { scope: remember, ...(constraint ? { constraint } : {}) }
                    : undefined;
            await api.approvals.decide(callId, decision, choice);
            onDecided?.();
        } catch (e) {
            setError(errorText(e));
            setBusy(false);
        }
    };

    return (
        <div className="approval">
            <span className="small">{t('tool.approvalNeeded')}</span>
            {risk ? <span className={`badge risk-${risk}`}>{t(`risk.${risk}`)}</span> : null}
            {rememberable ? (
                <select
                    aria-label={t('tool.remember')}
                    value={remember}
                    onChange={(e) => setRemember(e.target.value as Remember)}
                    disabled={busy}
                >
                    <option value="">{t('tool.rememberOnce')}</option>
                    <option value="session">{t('tool.rememberSession') + scope}</option>
                    <option value="always">{t('tool.rememberAlways') + scope}</option>
                </select>
            ) : null}
            <button type="button" className="primary" disabled={busy} onClick={() => void decide('approve')}>
                {t('tool.approve')}
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void decide('reject')}>
                {t('tool.reject')}
            </button>
            {error ? <p className="error small">{error}</p> : null}
        </div>
    );
}
