// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置 → 工具 → 技能(ADR 0048 第 5、8 节):已安装的 Skill、内置 Skill 的开关、从任务模板建草稿。
// 插件 Skill 随插件启用或停用,这里只显示。每个 Skill 显示给模型看的一句话 description;instructions 原文不在界面上显示
// (交给模型时按数据包装)。插件的 description 是第三方文本:只用 React 文本节点渲染,不要换成 dangerouslySetInnerHTML。
import { SKILL_CATALOG_MAX, type Settings, type SkillInfo } from '@fatcat-ai/shared';
import { useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { SettingsGroup, Switch } from './controls.js';
import { handOffDraft } from './draft-handoff.js';
import { useI18n } from './i18n.js';
import { pickText } from './plugin-ui.js';
import { navigate } from './router.js';
import { catalogOverflow } from './skills-ui.js';

export function SkillsSettings({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
    const { t } = useI18n();
    const [skills, setSkills] = useState<SkillInfo[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // 内置开关变了以后重新读取启用状态
    const toggles = JSON.stringify(settings.skills?.builtin ?? {});

    useEffect(() => {
        let alive = true;
        api.skills
            .list()
            .then((page) => alive && setSkills(page.items))
            .catch((e: unknown) => alive && setError(errorText(e)));
        return () => {
            alive = false;
        };
    }, [toggles]);

    const act = async (action: () => Promise<void>) => {
        setError(null);
        setBusy(true);
        try {
            await action();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <SettingsGroup title={t('skills.title')}>
            <p className="small muted">{t('skills.intro')}</p>
            {error ? <p className="error">{error}</p> : null}
            {skills === null && !error ? <p className="muted">{t('common.loading')}</p> : null}
            {skills?.length === 0 ? <p className="muted">{t('skills.empty')}</p> : null}
            {skills && catalogOverflow(skills) ? (
                <p className="warn small">{t('skills.tooMany', { max: SKILL_CATALOG_MAX })}</p>
            ) : null}
            <ul className="skill-list" data-testid="skill-list">
                {skills?.map((skill) => (
                    <li key={skill.id} data-skill={skill.id}>
                        <SkillRow
                            skill={skill}
                            busy={busy}
                            onToggle={(on) =>
                                void act(async () => {
                                    onSettings(await api.settings.update({ skills: { builtin: { [skill.id]: on } } }));
                                })
                            }
                            onTemplate={(index) =>
                                void act(async () => {
                                    // 服务器的 warnings 是给旧客户端的英文说明;确认卡本身已经说明草稿确认前不会运行
                                    const draft = await api.tasks.fromSkillTemplate(skill.id, index);
                                    handOffDraft({ ...draft, warnings: [] });
                                    navigate({ name: 'tasks' });
                                })
                            }
                        />
                    </li>
                ))}
            </ul>
        </SettingsGroup>
    );
}

function SkillRow({
    skill,
    busy,
    onToggle,
    onTemplate,
}: {
    skill: SkillInfo;
    busy: boolean;
    onToggle: (on: boolean) => void;
    onTemplate: (index: number) => void;
}) {
    const { t, locale } = useI18n();
    const name = pickText(skill.name, locale) || skill.id;
    const meta = (
        <>
            <code>{skill.id}</code>
            {' · '}
            {skill.source === 'builtin' ? t('skills.builtin') : t('skills.fromPlugin', { name: skill.pluginId ?? '' })}
        </>
    );
    return (
        <>
            {skill.source === 'builtin' ? (
                <Switch
                    name={`skill-${skill.id}`}
                    label={name}
                    hint={skill.description}
                    checked={skill.enabled}
                    disabled={busy}
                    onChange={onToggle}
                />
            ) : (
                <div className="switch-row">
                    <span className="switch-text">
                        <span>
                            {name}
                            {skill.enabled ? null : <span className="badge">{t('skills.off')}</span>}
                        </span>
                        <small className="muted">{skill.description}</small>
                    </span>
                </div>
            )}
            <p className="small muted skill-meta">
                {meta}
                {skill.source === 'plugin' ? ` · ${t('skills.pluginControlled')}` : ''}
            </p>
            <p className="small muted skill-meta">
                {t('skills.tools')}: <code>{skill.toolSet.join(', ')}</code>
            </p>
            {skill.enabled && skill.taskTemplates.length > 0 ? (
                <div className="skill-templates">
                    {skill.taskTemplates.map((template, index) => (
                        <button
                            key={index}
                            type="button"
                            className="secondary"
                            disabled={busy}
                            data-testid="skill-template"
                            onClick={() => onTemplate(index)}
                        >
                            {t('skills.templateCreate', { title: pickText(template.title, locale) })}
                        </button>
                    ))}
                    <p className="small muted">{t('skills.templateHint')}</p>
                </div>
            ) : null}
        </>
    );
}
