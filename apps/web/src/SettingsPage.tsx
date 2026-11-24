// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import {
    DEFAULT_SILENCE_END_SECONDS,
    MAX_SILENCE_END_SECONDS,
    MIN_SILENCE_END_SECONDS,
    type ModelKind,
    type ModelProfile,
    type ModelPurpose,
    type Settings,
    type SettingsPatch,
} from '@fatcat-ai/shared';
import { LOCALES, LOCALE_NAMES } from '@fatcat-ai/i18n';
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon.js';
import { SettingsCards } from './SettingsCards.js';
import {
    DEFAULT_SETTINGS_VIEW,
    SETTINGS_SECTIONS,
    resolveView,
    type SettingsSectionId,
    type SettingsView,
    SETTINGS_VIEW_KEY,
} from './settings-model.js';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { isValidKeyRef } from './live-turn.js';
import { FsRoots } from './FsRoots.js';
import { McpServers } from './McpServers.js';
import { Channels } from './Channels.js';
import { MailAccounts } from './MailAccounts.js';
import { EmbeddingIndex } from './EmbeddingIndex.js';
import { Preauthorizations } from './Preauthorizations.js';
import { EgressSection } from './EgressSection.js';
import { SecretsSection } from './SecretsSection.js';
import { DevicesSection } from './DevicesSection.js';
import { TotpSection } from './TotpSection.js';
import { ThemePicker } from './ThemePicker.js';
import { CodeProjects } from './CodeProjects.js';
import { Segmented, SettingsGroup, Switch } from './controls.js';
import { TimeZoneSetting } from './TimeZoneSetting.js';

const PURPOSES: ModelPurpose[] = ['chat', 'cheap', 'stt', 'tts'];

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
    vision: boolean;
    /** TTS 音色(params.voice);空串表示用服务器默认。 */
    voice: string;
}

const emptyDraft: Draft = {
    kind: 'openai-compatible',
    label: '',
    baseURL: '',
    model: '',
    apiKeyRef: '',
    purpose: ['chat'],
    vision: false,
    voice: '',
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
            <label className="inline">
                <input
                    type="checkbox"
                    name="vision"
                    checked={d.vision}
                    onChange={(e) => setD({ ...d, vision: e.target.checked })}
                />{' '}
                {t('models.vision')}
            </label>
            <span className="small muted">{t('models.visionHint')}</span>
            {d.purpose.includes('tts') ? (
                <label>
                    {t('models.voice')}
                    <input
                        name="voice"
                        placeholder="alloy"
                        maxLength={64}
                        value={d.voice}
                        onChange={(e) => setD({ ...d, voice: e.target.value })}
                    />
                    <span className="small muted">{t('models.voiceHint')}</span>
                </label>
            ) : null}
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
        // params 整体替换:保留其他参数,只改音色
        const otherParams = { ...profiles?.find((p) => p.id === id)?.params };
        delete otherParams.voice;
        const voice = d.voice.trim();
        const params = voice ? { ...otherParams, voice } : otherParams;
        const body = {
            label: d.label,
            kind: d.kind,
            ...(d.baseURL.trim() ? { baseURL: d.baseURL.trim() } : {}),
            model: d.model,
            apiKeyRef: d.apiKeyRef === '' ? null : d.apiKeyRef,
            purpose: d.purpose,
            vision: d.vision,
            ...(Object.keys(params).length > 0 || id ? { params } : {}),
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
        <section id="model-profiles">
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
                                    vision: p.vision === true,
                                    voice: p.params?.voice ?? '',
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
                                {p.vision ? ` · ${t('models.visionBadge')}` : ''}
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

function loadView(): SettingsView {
    try {
        const raw = window.sessionStorage.getItem(SETTINGS_VIEW_KEY);
        if (raw) {
            const v = JSON.parse(raw) as { section?: unknown; item?: unknown };
            return resolveView(v.section, v.item);
        }
    } catch {
        // 没有 sessionStorage 或内容损坏:用默认
    }
    return { ...DEFAULT_SETTINGS_VIEW };
}

export function SettingsPage({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
    const { t } = useI18n();
    const [profiles, setProfiles] = useState<ModelProfile[]>([]);
    const [note, setNote] = useState<string | null>(null);
    const [view, setView] = useState<SettingsView>(loadView);
    /** 自动抽取开关保存期间禁用,避免连点发出相互覆盖的请求。 */
    const [savingAutoExtract, setSavingAutoExtract] = useState(false);

    const show = (section: SettingsSectionId, item?: string) => {
        const next = resolveView(section, item);
        setView(next);
        try {
            window.sessionStorage.setItem(SETTINGS_VIEW_KEY, JSON.stringify(next));
        } catch {
            // 存不下也不影响使用
        }
        return next;
    };

    // 分区内所有分组单列排开;点左侧的子项时滚到对应分组
    const groupId = (section: string, item: string) => `settings-${section}-${item}`;
    const jump = (section: SettingsSectionId, item: string) => {
        const next = show(section, item);
        window.requestAnimationFrame(() =>
            document.getElementById(groupId(next.section, next.item))?.scrollIntoView({ block: 'start' }),
        );
    };

    const update = async (patch: SettingsPatch) => {
        try {
            onSettings(await api.settings.update(patch));
            setNote(t('settings.saved'));
        } catch (e) {
            setNote(errorText(e));
        }
    };

    useEffect(() => {
        let alive = true;
        void api.models
            .list()
            .then((page) => alive && setProfiles(page.items))
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, []);

    const voiceSelect = (key: 'defaultSttProfileId' | 'defaultTtsProfileId', purpose: 'stt' | 'tts') => (
        <select
            name={key}
            value={settings.voice[key] ?? ''}
            onChange={(e) => void update({ voice: { [key]: e.target.value === '' ? null : e.target.value } })}
        >
            <option value="">{t('settings.auto')}</option>
            {profiles
                .filter(
                    (p) =>
                        (p.kind === 'openai-compatible' && p.purpose.includes(purpose)) || p.id === settings.voice[key],
                )
                .map((p) => (
                    <option key={p.id} value={p.id}>
                        {p.label}
                    </option>
                ))}
        </select>
    );

    const manageProfiles = () => {
        document.getElementById('model-profiles')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const content = (item: string) => {
        switch (`${view.section}/${item}`) {
            case 'workbench/general':
                return (
                    <>
                        <SettingsGroup title={t('settings.appearance')}>
                            <ThemePicker value={settings.theme} onChange={(theme) => void update({ theme })} />
                            <label>
                                {t('settings.language')}
                                <select
                                    name="locale"
                                    value={settings.locale}
                                    onChange={(e) => void update({ locale: e.target.value as Settings['locale'] })}
                                >
                                    {LOCALES.map((code) => (
                                        <option key={code} value={code}>
                                            {LOCALE_NAMES[code]}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </SettingsGroup>
                        <SettingsGroup title={t('settings.general')}>
                            <TimeZoneSetting value={settings.timeZone} onChange={update} />
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
                            <Switch
                                name="autoExtract"
                                label={t('settings.autoExtractLabel')}
                                hint={t('settings.autoExtractHint', { n: settings.memory.extractDailyLimit })}
                                checked={settings.memory.autoExtract}
                                disabled={savingAutoExtract}
                                onChange={(autoExtract) => {
                                    setSavingAutoExtract(true);
                                    void update({ memory: { autoExtract } }).finally(() => setSavingAutoExtract(false));
                                }}
                            />
                        </SettingsGroup>
                    </>
                );
            case 'workbench/files':
                return <FsRoots />;
            case 'workbench/mail':
                return <MailAccounts />;
            case 'workbench/channels':
                return <Channels />;
            case 'models/overview':
                return (
                    <>
                        <SettingsCards
                            settings={settings}
                            profiles={profiles}
                            update={update}
                            onManage={manageProfiles}
                        />
                        <ModelProfiles onChanged={setProfiles} />
                    </>
                );
            case 'models/voice':
                return (
                    <SettingsGroup title={t('settings.voice')}>
                        <div className="field" data-testid="voice-input-mode">
                            <span>{t('settings.voiceInputMode')}</span>
                            <Segmented
                                label={t('settings.voiceInputMode')}
                                value={settings.voice.inputMode ?? 'text'}
                                options={[
                                    { value: 'voice', label: t('settings.voiceInputVoice') },
                                    { value: 'text', label: t('settings.voiceInputText') },
                                ]}
                                onChange={(inputMode) => void update({ voice: { inputMode } })}
                            />
                            <span className="small muted">{t('settings.voiceInputHint')}</span>
                        </div>
                        <label>
                            {t('settings.voiceStt')}
                            {voiceSelect('defaultSttProfileId', 'stt')}
                        </label>
                        <label>
                            {t('settings.voiceTts')}
                            {voiceSelect('defaultTtsProfileId', 'tts')}
                        </label>
                        <Switch
                            name="voiceAutoSend"
                            label={t('settings.voiceAutoSend')}
                            checked={settings.voice.autoSend}
                            onChange={(autoSend) => void update({ voice: { autoSend } })}
                        />
                        <Switch
                            name="voiceAutoSpeak"
                            label={t('settings.voiceAutoSpeak')}
                            hint={t('settings.voiceHint')}
                            checked={settings.voice.autoSpeak}
                            onChange={(autoSpeak) => void update({ voice: { autoSpeak } })}
                        />
                        <Switch
                            name="voiceContinuous"
                            label={t('settings.voiceContinuous')}
                            hint={t('settings.voiceContinuousHint')}
                            checked={settings.voice.continuous === true}
                            onChange={(continuous) => void update({ voice: { continuous } })}
                        />
                        <label>
                            {t('settings.voiceSilenceEnd')}
                            <input
                                type="number"
                                name="voiceSilenceEnd"
                                min={MIN_SILENCE_END_SECONDS}
                                max={MAX_SILENCE_END_SECONDS}
                                step={1}
                                defaultValue={settings.voice.silenceEndSeconds ?? DEFAULT_SILENCE_END_SECONDS}
                                onBlur={(e) => {
                                    const value = Number(e.target.value);
                                    if (
                                        Number.isInteger(value) &&
                                        value >= MIN_SILENCE_END_SECONDS &&
                                        value <= MAX_SILENCE_END_SECONDS
                                    ) {
                                        void update({ voice: { silenceEndSeconds: value } });
                                    }
                                }}
                            />
                        </label>
                    </SettingsGroup>
                );
            case 'models/embedding':
                // 配置档变化(新增 embed 档、改模型)后重新读取状态
                return <EmbeddingIndex key={profiles.map((p) => `${p.id}:${p.model}:${p.purpose.join()}`).join()} />;
            case 'tools/mcp':
                return <McpServers />;
            case 'tools/preauth':
                return <Preauthorizations />;
            case 'tools/browser':
                return (
                    <SettingsGroup title={t('settings.browser')}>
                        <Switch
                            name="browserEnabled"
                            label={t('settings.browserEnabled')}
                            hint={t('settings.browserNote')}
                            risk
                            checked={settings.browser?.enabled === true}
                            onChange={(enabled) => void update({ browser: { enabled } })}
                        />
                        <Switch
                            name="systemOpenEnabled"
                            label={t('settings.systemOpenEnabled')}
                            hint={t('settings.systemOpenNote')}
                            risk
                            checked={settings.systemOpen?.enabled === true}
                            onChange={(enabled) => void update({ systemOpen: { enabled } })}
                        />
                    </SettingsGroup>
                );
            case 'tools/code':
                return <CodeProjects settings={settings} onSettings={onSettings} />;
            case 'tools/market':
                return (
                    <SettingsGroup title={t('plugins.title')}>
                        <Switch
                            name="pluginMarketEnabled"
                            label={t('settings.pluginMarket')}
                            hint={t('settings.pluginMarketNote')}
                            checked={settings.plugins?.marketEnabled !== false}
                            onChange={(marketEnabled) => void update({ plugins: { marketEnabled } })}
                        />
                    </SettingsGroup>
                );
            case 'system/account':
                return (
                    <>
                        <TotpSection />
                        <DevicesSection />
                    </>
                );
            case 'system/secrets':
                return <SecretsSection />;
            case 'system/network':
                return (
                    <>
                        {settings.network ? (
                            <SettingsGroup title={t('settings.network')}>
                                <Switch
                                    name="allowFakeIp"
                                    label={t('settings.allowFakeIp')}
                                    hint={t('settings.allowFakeIpRisk')}
                                    risk
                                    checked={settings.network.allowFakeIp}
                                    onChange={(allowFakeIp) => void update({ network: { allowFakeIp } })}
                                />
                            </SettingsGroup>
                        ) : null}
                        <EgressSection />
                    </>
                );
            default:
                return null;
        }
    };

    const section = SETTINGS_SECTIONS.find((s) => s.id === view.section)!;
    // 左侧分类是纵向的 WAI-ARIA tablist:上下方向键 / Home / End 在分类间移动并切换,只有选中的分类在 Tab 顺序里
    const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
        const index = SETTINGS_SECTIONS.findIndex((s) => s.id === view.section);
        const last = SETTINGS_SECTIONS.length - 1;
        const next =
            event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? (index + 1) % SETTINGS_SECTIONS.length
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                  ? (index - 1 + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? last
                      : -1;
        if (next < 0) return;
        event.preventDefault();
        const target = SETTINGS_SECTIONS[next]!;
        show(target.id);
        document.getElementById(`settings-tab-${target.id}`)?.focus();
    };
    return (
        <div className="page settings-page">
            <h1>{t('settings.title')}</h1>
            <div className="settings-body">
                <aside className="settings-side">
                    <div
                        className="settings-tabs"
                        role="tablist"
                        aria-orientation="vertical"
                        aria-label={t('settings.title')}
                        onKeyDown={onTabKey}
                    >
                        {SETTINGS_SECTIONS.map((s) => (
                            <div key={s.id} className="settings-cat">
                                <button
                                    type="button"
                                    role="tab"
                                    id={`settings-tab-${s.id}`}
                                    aria-controls="settings-panel"
                                    aria-selected={s.id === view.section}
                                    tabIndex={s.id === view.section ? 0 : -1}
                                    className={s.id === view.section ? 'active' : ''}
                                    onClick={() => show(s.id)}
                                >
                                    <Icon name={s.icon} size={16} />
                                    {t(`settings.section.${s.id}`)}
                                </button>
                                {s.id === view.section ? (
                                    <nav className="settings-menu" aria-label={t(`settings.section.${s.id}`)}>
                                        {s.items.map((it) => (
                                            <button
                                                key={it.id}
                                                type="button"
                                                aria-current={it.id === view.item ? 'true' : undefined}
                                                className={it.id === view.item ? 'active' : ''}
                                                onClick={() => jump(s.id, it.id)}
                                            >
                                                {t(it.label as Parameters<typeof t>[0])}
                                            </button>
                                        ))}
                                    </nav>
                                ) : null}
                            </div>
                        ))}
                    </div>
                </aside>
                <div
                    className="settings-content"
                    role="tabpanel"
                    id="settings-panel"
                    aria-labelledby={`settings-tab-${section.id}`}
                >
                    {section.items.map((it) => (
                        <div key={it.id} className="settings-slot" id={groupId(section.id, it.id)}>
                            {content(it.id)}
                        </div>
                    ))}
                    {note ? (
                        <p className="small muted settings-note" role="status">
                            {note}
                        </p>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
