// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Agent, ModelProfile, SkillInfo } from '@fatcat-ai/shared';
import { useCallback, useEffect, useState } from 'react';
import { type AgentDraft, draftOf, emptyDraft, inputOf, parseToolSet } from './agent-form.js';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { pickText } from './plugin-ui.js';
import { AGENT_MAX_SKILLS, agentSkillState, toggleSkill } from './skills-ui.js';

/** 角色里列着、但已经不存在的 Skill:仍显示出来,方便取消勾选。 */
const missing = (id: string): SkillInfo => ({
    id,
    name: {},
    description: '',
    source: 'builtin',
    pluginId: null,
    enabled: false,
    toolSet: [],
    taskTemplates: [],
});

/** 代理页(ADR 0042):预置角色只读、可复制;自定义代理可新建、编辑、删除。 */
export function AgentsPage() {
    const { t, locale } = useI18n();
    const [agents, setAgents] = useState<Agent[] | null>(null);
    const [profiles, setProfiles] = useState<ModelProfile[]>([]);
    const [skills, setSkills] = useState<SkillInfo[]>([]);
    const [error, setError] = useState<string | null>(null);
    /** null = 不显示表单;'new' = 新建;否则是正在编辑的代理 id。 */
    const [editing, setEditing] = useState<string | 'new' | null>(null);
    const [draft, setDraft] = useState<AgentDraft>(emptyDraft());
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

    const load = useCallback(
        () =>
            Promise.all([
                api.agents.list(),
                api.models.list(),
                // Skill 列表读不到时只是不显示选项,不影响代理页
                api.skills.list().catch(() => ({ items: [] as SkillInfo[] })),
            ]),
        [],
    );
    const apply = ([list, models, installed]: Awaited<ReturnType<typeof load>>) => {
        setAgents(list.items);
        setProfiles(models.items);
        setSkills(installed.items);
    };
    const skillName = (id: string) => {
        const skill = skills.find((s) => s.id === id);
        return skill ? pickText(skill.name, locale) || id : id;
    };
    const draftToolSet = parseToolSet(draft.toolSet);
    const reload = () => load().then(apply, (e: unknown) => setError(errorText(e)));
    useEffect(() => {
        let alive = true;
        load().then(
            (result) => alive && apply(result),
            (e: unknown) => alive && setError(errorText(e)),
        );
        return () => {
            alive = false;
        };
        // apply 只用 setState,不依赖渲染值
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load]);

    const run = async (action: () => Promise<unknown>) => {
        setError(null);
        try {
            await action();
            setEditing(null);
            setConfirmDelete(null);
            await reload();
        } catch (e) {
            setError(errorText(e));
        }
    };

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        void run(() =>
            editing === 'new' ? api.agents.create(inputOf(draft)) : api.agents.update(editing!, inputOf(draft)),
        );
    };

    const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => setDraft({ ...draft, [key]: value });

    return (
        <div className="page">
            <h1>{t('agents.title')}</h1>
            {error ? <p className="error">{error}</p> : null}
            {agents === null ? <p className="muted">{t('common.loading')}</p> : null}
            <ul className="list" data-testid="agent-list">
                {agents?.map((agent) => (
                    <li key={agent.id} className="card agent-card" data-testid="agent-card">
                        <div className="row spread">
                            <strong>{agent.name}</strong>
                            <span>
                                {agent.builtin ? <span className="badge">{t('agents.builtin')}</span> : null}
                                {agent.toolSet.includes('delegate') ? (
                                    <span className="badge">{t('agents.canDelegate')}</span>
                                ) : null}
                            </span>
                        </div>
                        <p className="small muted agent-prompt">{agent.systemPrompt || t('agents.noPrompt')}</p>
                        <p className="small">
                            {t('agents.tools')}: <code>{agent.toolSet.join(', ')}</code>
                        </p>
                        {agent.skills && agent.skills.length > 0 ? (
                            <p className="small" data-testid="agent-skills">
                                {t('agents.skills')}:{' '}
                                {agent.skills.map((id, i) => {
                                    const state = agentSkillState(id, skills, agent.toolSet);
                                    return (
                                        <span key={id}>
                                            {i > 0 ? ', ' : ''}
                                            {skillName(id)}
                                            {state === 'ok' ? null : (
                                                <span className="badge warn">{t(`agents.skillState.${state}`)}</span>
                                            )}
                                        </span>
                                    );
                                })}
                            </p>
                        ) : null}
                        <p className="small muted">
                            {t('agents.memory')}:{' '}
                            {t(`agents.memory.${agent.memoryScope === 'none' ? 'none' : 'shared'}`)}
                            {' · '}
                            {t('agents.limits', {
                                depth: agent.maxDepth,
                                steps: agent.maxSteps,
                                tokens: agent.budgetTokens ?? '∞',
                                seconds: agent.budgetSeconds ?? '∞',
                            })}
                        </p>
                        <div className="row">
                            <button
                                type="button"
                                className="secondary"
                                onClick={() => void run(() => api.agents.copy(agent.id, {}))}
                            >
                                {t('agents.copy')}
                            </button>
                            {agent.builtin ? null : (
                                <>
                                    <button
                                        type="button"
                                        className="secondary"
                                        onClick={() => {
                                            setDraft(draftOf(agent));
                                            setEditing(agent.id);
                                        }}
                                    >
                                        {t('agents.edit')}
                                    </button>
                                    {confirmDelete === agent.id ? (
                                        <>
                                            <button
                                                type="button"
                                                onClick={() => void run(() => api.agents.remove(agent.id))}
                                            >
                                                {t('nav.confirm')}
                                            </button>
                                            <button
                                                type="button"
                                                className="secondary"
                                                onClick={() => setConfirmDelete(null)}
                                            >
                                                {t('nav.cancel')}
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            type="button"
                                            className="secondary"
                                            onClick={() => setConfirmDelete(agent.id)}
                                        >
                                            {t('agents.delete')}
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
            {editing ? (
                <form className="card form" onSubmit={submit} data-testid="agent-form">
                    <label>
                        {t('agents.name')}
                        <input
                            value={draft.name}
                            onChange={(e) => set('name', e.target.value)}
                            required
                            maxLength={80}
                        />
                    </label>
                    <label>
                        {t('agents.prompt')}
                        <textarea
                            value={draft.systemPrompt}
                            onChange={(e) => set('systemPrompt', e.target.value)}
                            rows={5}
                            maxLength={8000}
                        />
                    </label>
                    <label>
                        {t('agents.tools')}
                        <input
                            value={draft.toolSet}
                            onChange={(e) => set('toolSet', e.target.value)}
                            placeholder="kb., web.fetch, memory.search"
                            required
                        />
                    </label>
                    <p className="small muted">{t('agents.toolsHint')}</p>
                    <fieldset className="agent-skills" data-testid="agent-skill-picker">
                        <legend>{t('agents.skills')}</legend>
                        {skills.length === 0 ? <p className="small muted">{t('agents.noSkills')}</p> : null}
                        {[...skills, ...draft.skills.filter((id) => !skills.some((s) => s.id === id)).map(missing)].map(
                            (skill) => {
                                const checked = draft.skills.includes(skill.id);
                                const state = agentSkillState(skill.id, skills, draftToolSet);
                                return (
                                    <label key={skill.id} className="inline" data-skill={skill.id}>
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            disabled={!checked && draft.skills.length >= AGENT_MAX_SKILLS}
                                            onChange={() => set('skills', toggleSkill(draft.skills, skill.id))}
                                        />
                                        {pickText(skill.name, locale) || skill.id}
                                        {state === 'ok' ? null : (
                                            <span className="badge warn">{t(`agents.skillState.${state}`)}</span>
                                        )}
                                    </label>
                                );
                            },
                        )}
                        <p className="small muted">{t('agents.skillsHint', { max: AGENT_MAX_SKILLS })}</p>
                    </fieldset>
                    <label>
                        {t('agents.model')}
                        <select value={draft.modelProfileId} onChange={(e) => set('modelProfileId', e.target.value)}>
                            <option value="">{t('agents.modelDefault')}</option>
                            {profiles.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        {t('agents.memory')}
                        <select
                            value={draft.memoryScope}
                            onChange={(e) => set('memoryScope', e.target.value as 'shared' | 'none')}
                        >
                            <option value="shared">{t('agents.memory.shared')}</option>
                            <option value="none">{t('agents.memory.none')}</option>
                        </select>
                    </label>
                    <div className="row">
                        <label>
                            {t('agents.maxDepth')}
                            <input
                                type="number"
                                min={0}
                                max={4}
                                value={draft.maxDepth}
                                onChange={(e) => set('maxDepth', e.target.value)}
                            />
                        </label>
                        <label>
                            {t('agents.maxSteps')}
                            <input
                                type="number"
                                min={1}
                                max={20}
                                value={draft.maxSteps}
                                onChange={(e) => set('maxSteps', e.target.value)}
                            />
                        </label>
                        <label>
                            {t('agents.budgetTokens')}
                            <input
                                type="number"
                                min={1}
                                value={draft.budgetTokens}
                                onChange={(e) => set('budgetTokens', e.target.value)}
                            />
                        </label>
                        <label>
                            {t('agents.budgetSeconds')}
                            <input
                                type="number"
                                min={1}
                                value={draft.budgetSeconds}
                                onChange={(e) => set('budgetSeconds', e.target.value)}
                            />
                        </label>
                    </div>
                    <p className="small muted">{t('agents.limitsHint')}</p>
                    <div className="row">
                        <button type="submit">{t('agents.save')}</button>
                        <button type="button" className="secondary" onClick={() => setEditing(null)}>
                            {t('nav.cancel')}
                        </button>
                    </div>
                </form>
            ) : (
                <button
                    type="button"
                    onClick={() => {
                        setDraft(emptyDraft());
                        setEditing('new');
                    }}
                >
                    {t('agents.new')}
                </button>
            )}
        </div>
    );
}
