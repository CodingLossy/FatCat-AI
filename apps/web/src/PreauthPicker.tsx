// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { TaskAllowedTool, ToolInfo } from '@fatcat-ai/shared';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useI18n } from './i18n.js';
import { buildAllowedTools, preauthCandidates } from './preauth.js';

let cache: Promise<ToolInfo[]> | null = null;
function loadTools(): Promise<ToolInfo[]> {
    cache ??= api.tools
        .list()
        .then((page) => page.items)
        .catch(() => {
            cache = null;
            return [];
        });
    return cache;
}

/**
 * 预授权选择器(确认卡与任务编辑页共用):列出可预授权的只读工具,勾选后无人值守时可直接运行;
 * 需要限定范围的工具(web.fetch 要填域名)必须填范围。说明不能预授权的工具一定需要审批。
 */
export function PreauthPicker({
    initial,
    onChange,
}: {
    initial: TaskAllowedTool[];
    /** 每次变化通知外层:当前白名单,以及缺范围的工具名(没有时为 null)。 */
    onChange: (allowed: TaskAllowedTool[], missing: string | null) => void;
}) {
    const { t } = useI18n();
    const [tools, setTools] = useState<ToolInfo[] | null>(null);
    const [picked, setPicked] = useState<Record<string, { on: boolean; scope: string }>>(() =>
        Object.fromEntries(
            initial.map((a) => [a.tool, { on: true, scope: a.constraint?.domain ?? a.constraint?.pathPrefix ?? '' }]),
        ),
    );
    useEffect(() => {
        let alive = true;
        void loadTools().then((all) => alive && setTools(preauthCandidates(all)));
        return () => {
            alive = false;
        };
    }, []);

    const update = (next: Record<string, { on: boolean; scope: string }>) => {
        setPicked(next);
        if (tools) {
            const { allowed, missing } = buildAllowedTools(tools, next);
            onChange(allowed, missing);
        }
    };

    return (
        <fieldset className="preauth" data-testid="preauth-picker">
            <legend>{t('tasks.preauth.title')}</legend>
            <p className="small muted">{t('tasks.preauth.hint')}</p>
            {tools === null ? null : tools.length === 0 ? (
                <p className="small muted">{t('tasks.preauth.none')}</p>
            ) : null}
            {(tools ?? []).map((tool) => {
                const entry = picked[tool.name] ?? { on: false, scope: '' };
                const kind = tool.requiredConstraint;
                return (
                    <div key={tool.name} className="preauth-row">
                        <label className="inline">
                            <input
                                type="checkbox"
                                checked={entry.on}
                                onChange={(e) => update({ ...picked, [tool.name]: { ...entry, on: e.target.checked } })}
                            />{' '}
                            <code>{tool.name}</code>
                        </label>
                        {kind && entry.on ? (
                            <label className="small">
                                {kind === 'domain' ? t('tasks.preauth.domain') : t('tasks.preauth.path')}
                                <input
                                    value={entry.scope}
                                    placeholder={kind === 'domain' ? t('tasks.preauth.domainHint') : ''}
                                    aria-label={`${tool.name} ${kind}`}
                                    onChange={(e) =>
                                        update({ ...picked, [tool.name]: { ...entry, scope: e.target.value } })
                                    }
                                />
                            </label>
                        ) : null}
                    </div>
                );
            })}
            <p className="small muted">{t('tasks.preauth.never')}</p>
        </fieldset>
    );
}
