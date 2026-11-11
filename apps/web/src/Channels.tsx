// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Channel, ChannelPairing, ChannelStatus, WechatLoginState } from '@fatcat-ai/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { QrCode } from './QrCode.js';

type Row = Channel & { status: ChannelStatus | null };

/**
 * 设置页「渠道」(ADR 0022):列出渠道、启用 / 停用、生成配对码、显示绑定的账号与最近错误、降级提醒开关。
 * 1.0 只有微信:扫码登录(ADR 0024)在本页渲染二维码并每 2 秒轮询状态。配对码只在生成时显示一次。
 */
export function Channels() {
    const { t, locale } = useI18n();
    const [items, setItems] = useState<Row[] | null>(null);
    const [label, setLabel] = useState('');
    const [pairing, setPairing] = useState<(ChannelPairing & { channelId: string; minutes: number }) | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [login, setLogin] = useState<{ channelId: string; qrContent: string; state: WechatLoginState } | null>(null);

    const reload = useCallback(
        () =>
            api.channels
                .list()
                .then((page) =>
                    Promise.all(
                        page.items.map(async (c) => ({
                            ...c,
                            status: await api.channels.status(c.id).catch(() => null),
                        })),
                    ),
                )
                .then(setItems)
                .catch((e: unknown) => setError(errorText(e))),
        [],
    );

    useEffect(() => {
        void reload();
    }, [reload]);

    // 有渠道在启动或等待重试时每 2 秒刷新一次
    const busy = items?.some((c) => c.status?.state === 'starting' || c.status?.state === 'backoff') ?? false;
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(() => void reload(), 2000);
        return () => clearInterval(timer);
    }, [busy, reload]);

    // 扫码进行中每 2 秒查询一次状态;确认后刷新列表(渠道会用新令牌重启)
    const loginChannel =
        login && (login.state.state === 'pending' || login.state.state === 'scanned') ? login.channelId : null;
    useEffect(() => {
        if (!loginChannel) return;
        const timer = setInterval(() => {
            api.channels
                .wechatLoginState(loginChannel)
                .then((state) => {
                    setLogin((prev) => (prev?.channelId === loginChannel ? { ...prev, state } : prev));
                    if (state.state === 'confirmed') void reload();
                })
                .catch((e: unknown) => setError(errorText(e)));
        }, 2000);
        return () => clearInterval(timer);
    }, [loginChannel, reload]);

    const run = async (action: () => Promise<unknown>) => {
        setError(null);
        try {
            await action();
        } catch (err) {
            setError(errorText(err));
        }
        await reload();
    };

    const add = (e: FormEvent) => {
        e.preventDefault();
        void run(async () => {
            await api.channels.add({ kind: 'wechat', label: label.trim() || t('channels.kind.wechat') });
            setLabel('');
        });
    };

    const kindName = (kind: string) => (kind === 'wechat' ? t('channels.kind.wechat') : t('channels.kindUnknown'));

    return (
        <section>
            <h2>{t('channels.title')}</h2>
            <p className="muted small">{t('channels.hint')}</p>
            {error ? <p className="error">{error}</p> : null}
            {items?.length === 0 ? <p className="muted">{t('channels.empty')}</p> : null}
            <ul className="list">
                {items?.map((c) => (
                    <li key={c.id} className="card" data-channel={c.id}>
                        <div className="row spread">
                            <div>
                                <strong>{c.label}</strong>
                                <span className="small muted">
                                    {' · '}
                                    {kindName(c.kind)}
                                    {c.status ? ` · ${t(`channels.state.${c.status.state}`)}` : ''}
                                </span>
                                <div className="small muted">
                                    {c.binding
                                        ? t('channels.boundTo', {
                                              id: c.binding.maskedExternalUserId,
                                              at: new Date(c.binding.boundAt).toLocaleString(locale),
                                          })
                                        : t('channels.unbound')}
                                    {c.status
                                        ? ` · ${t('channels.counts', {
                                              ignored: c.status.ignoredCount,
                                              limited: c.status.rateLimitedCount,
                                          })}`
                                        : ''}
                                </div>
                                {c.status?.lastError ? (
                                    <div className="small error">
                                        {t('channels.lastError', { message: c.status.lastError.message })}
                                    </div>
                                ) : null}
                            </div>
                            <div className="row">
                                {c.kind === 'wechat' ? (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void run(async () => {
                                                const start = await api.channels.wechatLogin(c.id);
                                                setLogin({
                                                    channelId: c.id,
                                                    qrContent: start.qrContent,
                                                    state: { state: 'pending' },
                                                });
                                            })
                                        }
                                    >
                                        {t('channels.wechatLogin')}
                                    </button>
                                ) : null}
                                {c.binding ? (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (window.confirm(t('channels.unbindConfirm'))) {
                                                void run(() => api.channels.unbind(c.id));
                                            }
                                        }}
                                    >
                                        {t('channels.unbind')}
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void run(async () => {
                                                const p = await api.channels.pair(c.id);
                                                setPairing({
                                                    ...p,
                                                    channelId: c.id,
                                                    minutes: Math.max(
                                                        1,
                                                        Math.round((Date.parse(p.expiresAt) - Date.now()) / 60_000),
                                                    ),
                                                });
                                            })
                                        }
                                    >
                                        {t('channels.pair')}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => void run(() => api.channels.update(c.id, { enabled: !c.enabled }))}
                                >
                                    {c.enabled ? t('channels.disable') : t('channels.enable')}
                                </button>
                                <button
                                    type="button"
                                    className="danger"
                                    onClick={() => {
                                        if (window.confirm(t('channels.removeConfirm', { name: c.label }))) {
                                            void run(() => api.channels.remove(c.id));
                                        }
                                    }}
                                >
                                    {t('channels.remove')}
                                </button>
                            </div>
                        </div>
                        {login?.channelId === c.id ? (
                            <div className="qr-login" role="status">
                                {login.state.state === 'pending' || login.state.state === 'scanned' ? (
                                    <QrCode value={login.qrContent} label={t('channels.wechatQr')} />
                                ) : null}
                                <p className="small">
                                    {t(`channels.login.${login.state.state}`)}
                                    {login.state.code ? ` (${login.state.code})` : ''}
                                </p>
                            </div>
                        ) : null}
                        {pairing?.channelId === c.id && !c.binding ? (
                            <p className="small" role="status">
                                <code>{pairing.code}</code>{' '}
                                {t('channels.pairHint', {
                                    code: pairing.code,
                                    minutes: pairing.minutes,
                                })}
                            </p>
                        ) : null}
                        <label className="small">
                            <input
                                type="checkbox"
                                checked={c.notifyDegraded}
                                onChange={(e) =>
                                    void run(() => api.channels.update(c.id, { notifyDegraded: e.target.checked }))
                                }
                            />{' '}
                            {t('channels.notifyDegraded')}
                        </label>
                    </li>
                ))}
            </ul>
            <form className="card form" onSubmit={add}>
                <input
                    aria-label={t('channels.label')}
                    placeholder={`${t('channels.label')} (${t('channels.kind.wechat')})`}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    maxLength={40}
                />
                <button type="submit" className="primary">
                    {t('channels.add')}
                </button>
            </form>
        </section>
    );
}
