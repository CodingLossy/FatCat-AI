// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { bareDomainSuggestion, splitDomainScopes, type TaskAllowedTool, type ToolInfo } from '@fatcat-ai/shared';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useI18n } from './i18n.js';
import { buildAllowedTools, initialScopes, preauthCandidates, type ScopeProblem } from './preauth.js';

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
    /** 每次变化通知外层:当前白名单,以及阻止保存的问题(已本地化的文字,没有时为 null)。 */
    onChange: (allowed: TaskAllowedTool[], missing: string | null) => void;
}) {
    const { t } = useI18n();
    const [tools, setTools] = useState<ToolInfo[] | null>(null);
    const [picked, setPicked] = useState<Record<string, { on: boolean; scope: string }>>(() => initialScopes(initial));
    const describe = (problem: ScopeProblem | null): string | null => {
        if (!problem) return null;
        return problem.kind === 'missing'
            ? t('tasks.preauth.needScope', { tool: problem.tool })
            : t(`tasks.preauth.problem.${problem.kind}`, { value: problem.value });
    };
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
            const { allowed, problem } = buildAllowedTools(tools, next);
            onChange(allowed, describe(problem));
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
                const parts = kind === 'domain' ? splitDomainScopes(entry.scope) : [];
                const bare = parts.length === 1 ? bareDomainSuggestion(parts[0]!.toLowerCase()) : null;
                const typed =
                    kind === 'domain' && entry.scope.trim() ? buildAllowedTools([tool], { [tool.name]: entry }) : null;
                const setScope = (scope: string) => update({ ...picked, [tool.name]: { ...entry, scope } });
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
                            <div className="preauth-scope">
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
                                {kind === 'domain' ? (
                                    <>
                                        <p className="small muted">{t('tasks.preauth.domainRule')}</p>
                                        {typed?.problem && typed.problem.kind !== 'missing' ? (
                                            <p className="small error" role="alert">
                                                {t(`tasks.preauth.problem.${typed.problem.kind}`, {
                                                    value: typed.problem.value,
                                                })}
                                            </p>
                                        ) : bare ? (
                                            <p className="small" data-testid="preauth-bare-hint">
                                                {t('tasks.preauth.bareHint', { domain: parts[0]!, www: bare.www })}{' '}
                                                <button
                                                    type="button"
                                                    className="link"
                                                    onClick={() => setScope(`${entry.scope.trim()}, ${bare.www}`)}
                                                >
                                                    {t('tasks.preauth.addWww', { www: bare.www })}
                                                </button>
                                                {' / '}
                                                <button
                                                    type="button"
                                                    className="link"
                                                    onClick={() => setScope(`${entry.scope.trim()}, ${bare.wildcard}`)}
                                                >
                                                    {t('tasks.preauth.addWildcard', { wildcard: bare.wildcard })}
                                                </button>
                                            </p>
                                        ) : null}
                                    </>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                );
            })}
            <p className="small muted">{t('tasks.preauth.never')}</p>
        </fieldset>
    );
}
