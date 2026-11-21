// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置页「已配对设备」一节(ADR 0045 第 1 节):生成一次性配对码(二维码 + 文字)、列出、改名、吊销设备。
// 配对码明文只在这一次响应里出现,5 分钟后或关闭后即丢弃,界面不写入任何存储。
import type { CreatedPairingCode, Device } from '@fatcat-ai/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { QrCode } from './QrCode.js';

/** 手机上打开的配对地址:带上配对码,由手机端页面换令牌。 */
export function pairingUrl(origin: string, code: string): string {
    return `${origin}/pair?code=${encodeURIComponent(code)}`;
}

export function DevicesSection() {
    const { t, locale } = useI18n();
    const [devices, setDevices] = useState<Device[] | null>(null);
    const [available, setAvailable] = useState(true);
    const [code, setCode] = useState<CreatedPairingCode | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
    const [revoking, setRevoking] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setDevices((await api.devices.list()).items);
        } catch {
            setAvailable(false); // 老服务器没有这个接口:整节不显示
        }
    }, []);

    useEffect(() => {
        let alive = true;
        api.devices
            .list()
            .then((page) => alive && setDevices(page.items))
            .catch(() => alive && setAvailable(false));
        return () => {
            alive = false;
        };
    }, []);

    // 配对码显示期间每秒刷新倒计时;过期后自动收起
    const expiresAt = code ? Date.parse(code.expiresAt) : 0;
    useEffect(() => {
        if (!code) return undefined;
        const timer = setInterval(() => {
            const t0 = Date.now();
            setNow(t0);
            if (t0 >= Date.parse(code.expiresAt)) {
                setCode(null);
                void load();
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [code, load]);

    if (!available || !devices) return null;

    const run = async (work: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await work();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };
    const addDevice = () =>
        run(async () => {
            const created = await api.devices.createPairingCode();
            setNow(Date.now());
            setCode(created);
        });
    const submitRename = (e: FormEvent) => {
        e.preventDefault();
        const target = renaming;
        if (!target) return;
        void run(async () => {
            await api.devices.rename(target.id, { name: target.name.trim() });
            setRenaming(null);
            await load();
        });
    };
    const revoke = (id: string) =>
        run(async () => {
            await api.devices.revoke(id);
            setRevoking(null);
            await load();
        });

    const fmt = (iso: string) => new Date(iso).toLocaleString(locale);
    const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000));

    return (
        <section className="card form" aria-label={t('devices.title')}>
            <h2>{t('devices.title')}</h2>
            {error ? (
                <p className="error" role="alert">
                    {error}
                </p>
            ) : null}
            {code ? (
                <div className="device-pairing" data-testid="pairing-code">
                    <QrCode value={pairingUrl(window.location.origin, code.code)} label={t('devices.qr')} size={176} />
                    <div>
                        <p className="small muted">{t('devices.codeHint')}</p>
                        <p className="pairing-code" aria-label={t('devices.code')}>
                            {code.code}
                        </p>
                        <p className="small muted">
                            {t('devices.expiresIn', {
                                m: Math.floor(secondsLeft / 60),
                                s: String(secondsLeft % 60).padStart(2, '0'),
                            })}
                        </p>
                        <button type="button" onClick={() => setCode(null)}>
                            {t('devices.close')}
                        </button>
                    </div>
                </div>
            ) : (
                <span className="row">
                    <button type="button" className="primary" onClick={() => void addDevice()} disabled={busy}>
                        {t('devices.add')}
                    </button>
                </span>
            )}
            {devices.length === 0 ? <p className="small muted">{t('devices.none')}</p> : null}
            <ul className="list" aria-label={t('devices.title')}>
                {devices.map((d) => (
                    <li key={d.id} className="row spread" data-device-id={d.id}>
                        {renaming?.id === d.id ? (
                            <form className="row" onSubmit={submitRename}>
                                <input
                                    name="deviceName"
                                    aria-label={t('devices.name')}
                                    value={renaming.name}
                                    maxLength={60}
                                    onChange={(e) => setRenaming({ id: d.id, name: e.target.value })}
                                    required
                                    autoFocus
                                />
                                <button type="submit" className="primary" disabled={busy}>
                                    {t('devices.save')}
                                </button>
                                <button type="button" onClick={() => setRenaming(null)}>
                                    {t('devices.cancel')}
                                </button>
                            </form>
                        ) : (
                            <span>
                                <strong>{d.name}</strong>
                                <br />
                                <span className="small muted">
                                    {d.lastUsedAt
                                        ? t('devices.lastUsed', { at: fmt(d.lastUsedAt) })
                                        : t('devices.neverUsed')}
                                    {' · '}
                                    {t('devices.pairedAt', { at: fmt(d.createdAt) })}
                                </span>
                            </span>
                        )}
                        {renaming?.id === d.id ? null : (
                            <span className="row">
                                <button type="button" onClick={() => setRenaming({ id: d.id, name: d.name })}>
                                    {t('devices.rename')}
                                </button>
                                {revoking === d.id ? (
                                    <>
                                        <button
                                            type="button"
                                            className="danger"
                                            disabled={busy}
                                            onClick={() => void revoke(d.id)}
                                        >
                                            {t('devices.confirmRevoke')}
                                        </button>
                                        <button type="button" onClick={() => setRevoking(null)}>
                                            {t('devices.cancel')}
                                        </button>
                                    </>
                                ) : (
                                    <button type="button" className="danger" onClick={() => setRevoking(d.id)}>
                                        {t('devices.revoke')}
                                    </button>
                                )}
                            </span>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
}
