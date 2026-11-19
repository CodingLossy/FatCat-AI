// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ModelProfile, ModelPurpose, Settings, SettingsPatch } from '@fatcat-ai/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { api, errorText } from './api.js';
import { Icon } from './Icon.js';
import { useI18n } from './i18n.js';
import { inputShare, pushSample, sparkPoints, sumUsage, type UsageTotals } from './settings-model.js';

/** 「最近 N 个会话」的 N:界面只汇总已有的会话页,不另开汇总接口(设计第 9 节)。 */
const USAGE_SESSIONS = 5;

function Card({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
    return (
        <section className="dash-card" data-testid={testId} aria-label={title}>
            <h3>{title}</h3>
            {children}
        </section>
    );
}

function CoreStatusCard() {
    const { t } = useI18n();
    const [up, setUp] = useState<boolean | null>(null);
    const [meta, setMeta] = useState<{ serverVersion: string; protocolVersion: number } | null>(null);
    const [samples, setSamples] = useState<number[]>([]);

    useEffect(() => {
        let alive = true;
        const tick = () => {
            const start = performance.now();
            void fetch('/healthz', { cache: 'no-store' }).then(
                (res) => {
                    if (!alive) return;
                    setUp(res.ok);
                    if (res.ok) setSamples((s) => pushSample(s, performance.now() - start));
                },
                () => alive && setUp(false),
            );
        };
        tick();
        void api
            .meta()
            .then((m) => alive && setMeta(m))
            .catch(() => undefined);
        const id = window.setInterval(tick, 30_000);
        return () => {
            alive = false;
            window.clearInterval(id);
        };
    }, []);

    const points = sparkPoints(samples, 120, 28);
    return (
        <Card title={t('settings.card.core')} testId="card-core">
            <p className={`dash-value ${up === false ? 'error' : ''}`}>
                {up === null ? '—' : up ? t('settings.card.coreUp') : t('settings.card.coreDown')}
            </p>
            <p className="small muted">
                {meta
                    ? t('settings.card.coreVersion', { version: meta.serverVersion, protocol: meta.protocolVersion })
                    : ' '}
            </p>
            {points ? (
                <svg className="spark" viewBox="0 0 120 28" aria-label={t('settings.card.coreSpark')} role="img">
                    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
            ) : null}
        </Card>
    );
}

function LatencyCard({ profile }: { profile: ModelProfile | null }) {
    const { t } = useI18n();
    const [note, setNote] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // 测试连接会向模型提供商发一次外连请求,只在点击时运行,从不自动运行。
    const run = async () => {
        if (!profile) return;
        setBusy(true);
        try {
            const r = await api.models.test(profile.id);
            setNote(r.ok ? `${Math.round(r.latencyMs)} ms` : t('models.testFail', { msg: `${r.error}: ${r.message}` }));
        } catch (e) {
            setNote(t('models.testFail', { msg: errorText(e) }));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card title={t('settings.card.latency')} testId="card-latency">
            {profile ? (
                <>
                    <p className="dash-value">{note ?? '—'}</p>
                    <p className="small muted">{profile.label}</p>
                    <button type="button" disabled={busy} onClick={() => void run()}>
                        {t('settings.card.latencyTest')}
                    </button>
                </>
            ) : (
                <EmptyState text={t('settings.card.noModel')} />
            )}
        </Card>
    );
}

function EmptyState({ text }: { text: string }) {
    return (
        <div className="dash-empty">
            <Icon name="cat" size={24} />
            <span className="small muted">{text}</span>
        </div>
    );
}

function UsageCard() {
    const { t } = useI18n();
    const [state, setState] = useState<{ totals: UsageTotals; sessions: number } | 'error' | null>(null);

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const page = await api.sessions.list({ limit: USAGE_SESSIONS });
                const pages = await Promise.all(page.items.map((s) => api.sessions.messages(s.id, { limit: 200 })));
                if (alive) setState({ totals: sumUsage(pages.flatMap((p) => p.items)), sessions: page.items.length });
            } catch {
                if (alive) setState('error');
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    const totals = state && state !== 'error' ? state.totals : null;
    const share = totals ? inputShare(totals) : null;
    const circumference = 2 * Math.PI * 15;
    return (
        <Card title={t('settings.card.usage')} testId="card-usage">
            {state === 'error' ? <p className="error small">{t('settings.card.usageError')}</p> : null}
            {state === null ? <p className="dash-value">—</p> : null}
            {totals && share === null ? <EmptyState text={t('settings.card.usageEmpty')} /> : null}
            {totals && share !== null ? (
                <div className="row">
                    <svg className="ring" viewBox="0 0 36 36" role="img" aria-label={t('settings.card.usageRing')}>
                        <circle cx="18" cy="18" r="15" fill="none" stroke="var(--border-strong)" strokeWidth="4" />
                        <circle
                            cx="18"
                            cy="18"
                            r="15"
                            fill="none"
                            stroke="var(--accent)"
                            strokeWidth="4"
                            strokeDasharray={`${share * circumference} ${circumference}`}
                            transform="rotate(-90 18 18)"
                        />
                    </svg>
                    <div>
                        <p className="small">{t('settings.card.usageIn', { n: totals.input.toLocaleString() })}</p>
                        <p className="small">{t('settings.card.usageOut', { n: totals.output.toLocaleString() })}</p>
                    </div>
                </div>
            ) : null}
            {state && state !== 'error' ? (
                <p className="small muted">{t('settings.card.usageScope', { n: state.sessions })}</p>
            ) : null}
        </Card>
    );
}

function pickProfile(profiles: ModelProfile[], id: string | null | undefined, purpose: ModelPurpose) {
    return profiles.find((p) => p.id === id) ?? profiles.find((p) => p.purpose.includes(purpose)) ?? null;
}

function VoiceEngineCard({ settings, profiles, onManage }: CardsProps) {
    const { t } = useI18n();
    const stt = pickProfile(profiles, settings.voice.defaultSttProfileId, 'stt');
    const tts = pickProfile(profiles, settings.voice.defaultTtsProfileId, 'tts');
    return (
        <Card title={t('settings.card.voiceEngine')} testId="card-voice-engine">
            {stt || tts ? (
                <dl className="dash-kv">
                    <dt>STT</dt>
                    <dd>{stt?.label ?? t('settings.card.notConfigured')}</dd>
                    <dt>TTS</dt>
                    <dd>{tts?.label ?? t('settings.card.notConfigured')}</dd>
                </dl>
            ) : (
                <>
                    <EmptyState text={t('settings.card.notConfigured')} />
                    <button type="button" className="link" onClick={onManage}>
                        {t('settings.card.manage')}
                    </button>
                </>
            )}
        </Card>
    );
}

function ModelConfigCard({ settings, profiles, update, onManage }: CardsProps) {
    const { t } = useI18n();
    const select = (key: 'defaultChatProfileId' | 'defaultCheapProfileId', purpose: ModelPurpose) => (
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
        <Card title={t('settings.card.modelConfig')} testId="card-model-config">
            <p className="small muted">{t('settings.card.profileCount', { n: profiles.length })}</p>
            <label className="dash-field">
                {t('settings.defaultChat')}
                {select('defaultChatProfileId', 'chat')}
            </label>
            <label className="dash-field">
                {t('settings.defaultCheap')}
                {select('defaultCheapProfileId', 'cheap')}
            </label>
            <button type="button" className="link" onClick={onManage}>
                {t('settings.card.manage')}
            </button>
        </Card>
    );
}

function VoiceInteractionCard({ settings, update }: CardsProps) {
    const { t } = useI18n();
    const toggle = (key: 'autoSend' | 'autoSpeak', label: string) => (
        <label className="switch">
            <input
                type="checkbox"
                role="switch"
                name={`voice-${key}`}
                checked={settings.voice[key]}
                onChange={(e) => void update({ voice: { [key]: e.target.checked } })}
            />
            <span>{label}</span>
        </label>
    );
    return (
        <Card title={t('settings.card.voiceInteraction')} testId="card-voice-interaction">
            {toggle('autoSend', t('settings.voiceAutoSend'))}
            {toggle('autoSpeak', t('settings.voiceAutoSpeak'))}
        </Card>
    );
}

export interface CardsProps {
    settings: Settings;
    profiles: ModelProfile[];
    update: (patch: SettingsPatch) => Promise<void>;
    /** 跳到下面的模型配置档管理区。 */
    onManage: () => void;
}

/** 「模型与语音」概览的六张卡片;每张都由现有接口支撑,没有数据就显示空状态,不写编造的数字。 */
export function SettingsCards(props: CardsProps) {
    const { settings, profiles } = props;
    const chat = pickProfile(profiles, settings.defaultChatProfileId, 'chat');
    return (
        <div className="dash-grid" data-testid="settings-cards">
            <CoreStatusCard />
            <LatencyCard profile={chat} />
            <UsageCard />
            <VoiceEngineCard {...props} />
            <ModelConfigCard {...props} />
            <VoiceInteractionCard {...props} />
        </div>
    );
}
