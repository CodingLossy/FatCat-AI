// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ModelKind, ModelProfile, ModelPurpose, Settings, SettingsPatch } from '@fatcat-ai/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { isValidKeyRef } from './live-turn.js';
import { FsRoots } from './FsRoots.js';
import { McpServers } from './McpServers.js';
import { MailAccounts } from './MailAccounts.js';
import { EmbeddingIndex } from './EmbeddingIndex.js';
import { Preauthorizations } from './Preauthorizations.js';

const PURPOSES: ModelPurpose[] = ['chat', 'cheap'];

const KINDS: ModelKind[] = ['openai-compatible', 'anthropic', 'gemini'];

/** 原生类型的默认接口地址(与服务器端适配器一致),留空即可。 */
const DEFAULT_BASE_URLS: Partial<Record<ModelKind, string>> = {
    anthropic: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

interface Draft {
    kind: ModelKind;
    label: string;
    baseURL: string;
    model: string;
    apiKeyRef: string;
    purpose: ModelPurpose[];
}

const emptyDraft: Draft = {
    kind: 'openai-compatible',
    label: '',
    baseURL: '',
    model: '',
    apiKeyRef: '',
    purpose: ['chat'],
};

function ProfileForm({
    initial,
    onSave,
    onCancel,
}: {
    initial: Draft;
    onSave: (d: Draft) => Promise<void>;
    onCancel: () => void;
}) {
    const { t } = useI18n();
    const [d, setD] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const keyRefOk = isValidKeyRef(d.apiKeyRef.trim());

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!keyRefOk) return;
        try {
            await onSave({ ...d, apiKeyRef: d.apiKeyRef.trim() });
        } catch (err) {
            setError(errorText(err));
        }
    };

    const togglePurpose = (p: ModelPurpose) =>
        setD({ ...d, purpose: d.purpose.includes(p) ? d.purpose.filter((x) => x !== p) : [...d.purpose, p] });

    return (
        <form className="card form" onSubmit={submit} aria-label="model-profile">
            <label>
                {t('models.label')}
                <input name="label" value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} required />
            </label>
            <label>
                {t('models.kind')}
                <select name="kind" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as ModelKind })}>
                    {KINDS.map((k) => (
                        <option key={k} value={k}>
                            {k}
                        </option>
                    ))}
                </select>
            </label>
            <label>
                {t('models.baseURL')}
                <input
                    name="baseURL"
                    type="url"
                    placeholder={DEFAULT_BASE_URLS[d.kind] ?? 'https://api.deepseek.com/v1'}
                    value={d.baseURL}
                    onChange={(e) => setD({ ...d, baseURL: e.target.value })}
                    required={d.kind === 'openai-compatible'}
                />
            </label>
            <label>
                {t('models.model')}
                <input name="model" value={d.model} onChange={(e) => setD({ ...d, model: e.target.value })} required />
            </label>
            <label>
                {t('models.keyRef')}
                <input
                    name="apiKeyRef"
                    placeholder="env:DEEPSEEK_API_KEY"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={!keyRefOk}
                    value={d.apiKeyRef}
                    onChange={(e) => setD({ ...d, apiKeyRef: e.target.value })}
                />
                <span className={`small ${keyRefOk ? 'muted' : 'error'}`}>
                    {keyRefOk ? t('models.keyRefHint') : t('models.keyRefInvalid')}
                </span>
            </label>
            <fieldset>
                <legend>{t('models.purpose')}</legend>
                {PURPOSES.map((p) => (
                    <label key={p} className="inline">
                        <input type="checkbox" checked={d.purpose.includes(p)} onChange={() => togglePurpose(p)} /> {p}
                    </label>
                ))}
            </fieldset>
            {error ? <p className="error">{error}</p> : null}
            <div className="row">
                <button type="submit" className="primary" disabled={!keyRefOk || d.purpose.length === 0}>
                    {t('models.save')}
                </button>
                <button type="button" onClick={onCancel}>
                    {t('models.cancel')}
                </button>
            </div>
        </form>
    );
}

function ModelProfiles({ onChanged }: { onChanged: (profiles: ModelProfile[]) => void }) {
    const { t } = useI18n();
    const [profiles, setProfiles] = useState<ModelProfile[] | null>(null);
    const [editing, setEditing] = useState<string | 'new' | null>(null);
    const [notes, setNotes] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        try {
            const page = await api.models.list();
            setProfiles(page.items);
            onChanged(page.items);
        } catch (e) {
            setError(errorText(e));
        }
    }, [onChanged]);

    useEffect(() => {
        void reload();
    }, [reload]);

    const save = async (id: string | null, d: Draft) => {
        const body = {
            label: d.label,
            kind: d.kind,
            ...(d.baseURL.trim() ? { baseURL: d.baseURL.trim() } : {}),
            model: d.model,
            apiKeyRef: d.apiKeyRef === '' ? null : d.apiKeyRef,
            purpose: d.purpose,
        };
        if (id) await api.models.update(id, body);
        else await api.models.create(body);
        setEditing(null);
        await reload();
    };

    const remove = async (p: ModelProfile) => {
        if (!window.confirm(t('models.deleteConfirm', { label: p.label }))) return;
        await api.models.delete(p.id).catch((e: unknown) => setError(errorText(e)));
        await reload();
    };

    const test = async (p: ModelProfile) => {
        setNotes((n) => ({ ...n, [p.id]: t('common.loading') }));
        try {
            const r = await api.models.test(p.id);
            const note = r.ok
                ? t('models.testOk', { ms: Math.round(r.latencyMs) })
                : t('models.testFail', { msg: `${r.error}: ${r.message}` });
            setNotes((n) => ({ ...n, [p.id]: note }));
        } catch (e) {
            setNotes((n) => ({ ...n, [p.id]: t('models.testFail', { msg: errorText(e) }) }));
        }
    };

    return (
        <section>
            <h2>{t('models.title')}</h2>
            {error ? <p className="error">{error}</p> : null}
            {profiles === null ? <p className="muted">{t('common.loading')}</p> : null}
            {profiles?.length === 0 ? <p className="muted">{t('models.empty')}</p> : null}
            <ul className="list">
                {profiles?.map((p) =>
                    editing === p.id ? (
                        <li key={p.id}>
                            <ProfileForm
                                initial={{
                                    label: p.label,
                                    kind: p.kind,
                                    baseURL: p.baseURL ?? '',
                                    model: p.model,
                                    apiKeyRef: p.apiKeyRef ?? '',
                                    purpose: p.purpose,
                                }}
                                onSave={(d) => save(p.id, d)}
                                onCancel={() => setEditing(null)}
                            />
                        </li>
                    ) : (
                        <li key={p.id} className="card profile" data-profile={p.label}>
                            <div className="row spread">
                                <strong>{p.label}</strong>
                                <span className={`badge key-${p.keyStatus}`} data-testid="key-status">
                                    {t('models.keyStatus')}: {t(`keyStatus.${p.keyStatus}`)}
                                </span>
                            </div>
                            <div className="small muted">
                                {p.kind} · {p.model} · {p.baseURL ?? DEFAULT_BASE_URLS[p.kind] ?? ''} ·{' '}
                                {p.apiKeyRef ?? '—'} · {p.purpose.join(', ')}
                            </div>
                            <div className="row">
                                <button type="button" onClick={() => void test(p)}>
                                    {t('models.test')}
                                </button>
                                <button type="button" onClick={() => setEditing(p.id)}>
                                    {t('models.edit')}
                                </button>
                                <button type="button" className="danger" onClick={() => void remove(p)}>
                                    {t('models.delete')}
                                </button>
                            </div>
                            {notes[p.id] ? <p className="small">{notes[p.id]}</p> : null}
                        </li>
                    ),
                )}
            </ul>
            {editing === 'new' ? (
                <ProfileForm initial={emptyDraft} onSave={(d) => save(null, d)} onCancel={() => setEditing(null)} />
            ) : (
                <button type="button" className="primary" onClick={() => setEditing('new')}>
                    {t('models.add')}
                </button>
            )}
        </section>
    );
}

export function SettingsPage({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
    const { t } = useI18n();
    const [profiles, setProfiles] = useState<ModelProfile[]>([]);
    const [note, setNote] = useState<string | null>(null);
    /** 自动抽取开关保存期间禁用,避免连点发出相互覆盖的请求。 */
    const [savingAutoExtract, setSavingAutoExtract] = useState(false);

    const update = async (patch: SettingsPatch) => {
        try {
            onSettings(await api.settings.update(patch));
            setNote(t('settings.saved'));
        } catch (e) {
            setNote(errorText(e));
        }
    };

    const profileSelect = (key: 'defaultChatProfileId' | 'defaultCheapProfileId', purpose: ModelPurpose) => (
        <select
            value={settings[key] ?? ''}
            onChange={(e) => void update({ [key]: e.target.value === '' ? null : e.target.value })}
        >
            <option value="">{t('settings.auto')}</option>
            {profiles
                .filter((p) => p.purpose.includes(purpose) || p.id === settings[key])
                .map((p) => (
                    <option key={p.id} value={p.id}>
                        {p.label}
                    </option>
                ))}
        </select>
    );

    return (
        <div className="page">
            <h1>{t('settings.title')}</h1>
            <section className="card form">
                <h2>{t('settings.general')}</h2>
                <label>
                    {t('settings.language')}
                    <select
                        name="locale"
                        value={settings.locale}
                        onChange={(e) => void update({ locale: e.target.value as Settings['locale'] })}
                    >
                        <option value="zh-CN">中文</option>
                        <option value="en">English</option>
                    </select>
                </label>
                <label>
                    {t('settings.theme')}
                    <select
                        name="theme"
                        value={settings.theme}
                        onChange={(e) => void update({ theme: e.target.value as Settings['theme'] })}
                    >
                        <option value="system">{t('settings.themeSystem')}</option>
                        <option value="light">{t('settings.themeLight')}</option>
                        <option value="dark">{t('settings.themeDark')}</option>
                    </select>
                </label>
                <label>
                    {t('settings.defaultChat')}
                    {profileSelect('defaultChatProfileId', 'chat')}
                </label>
                <label>
                    {t('settings.defaultCheap')}
                    {profileSelect('defaultCheapProfileId', 'cheap')}
                </label>
                <label>
                    {t('settings.chunkChars')}
                    <input
                        type="number"
                        name="chunkChars"
                        min={200}
                        max={4000}
                        step={100}
                        defaultValue={settings.knowledgeBase.chunkChars}
                        onBlur={(e) => {
                            const value = Number(e.target.value);
                            if (Number.isInteger(value) && value >= 200 && value <= 4000) {
                                void update({ knowledgeBase: { chunkChars: value } });
                            }
                        }}
                    />
                </label>
                <label className="inline">
                    <input
                        type="checkbox"
                        name="autoExtract"
                        checked={settings.memory.autoExtract}
                        disabled={savingAutoExtract}
                        onChange={(e) => {
                            const autoExtract = e.target.checked;
                            setSavingAutoExtract(true);
                            void update({ memory: { autoExtract } }).finally(() => setSavingAutoExtract(false));
                        }}
                    />{' '}
                    {t('settings.autoExtract', { n: settings.memory.extractDailyLimit })}
                </label>
                {note ? <p className="small muted">{note}</p> : null}
            </section>
            <ModelProfiles onChanged={setProfiles} />
            {/* 配置档变化(新增 embed 档、改模型)后重新读取状态 */}
            <EmbeddingIndex key={profiles.map((p) => `${p.id}:${p.model}:${p.purpose.join()}`).join()} />
            <FsRoots />
            <MailAccounts />
            <McpServers />
            <Preauthorizations />
        </div>
    );
}
