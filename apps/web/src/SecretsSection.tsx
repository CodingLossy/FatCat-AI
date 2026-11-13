// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置页「密钥」一节(ADR 0026):密钥文件的状态、主密钥来源与指纹、显式迁移。
// 迁移不会自动发生;secrets.yaml.migrated 只能用命令行清理,这里只显示提示文字。
import type { PlaintextBackupAction, SecretsMigrateResponse, SecretsStatus } from '@fatcat-ai/shared';
import { useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';

export function SecretsSection() {
    const { t } = useI18n();
    const [status, setStatus] = useState<SecretsStatus | null>(null);
    const [available, setAvailable] = useState(true); // 老服务器没有这个接口(404):整节不显示
    const [confirming, setConfirming] = useState(false);
    const [backups, setBackups] = useState<PlaintextBackupAction>('keep');
    const [deleteConfirmed, setDeleteConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<SecretsMigrateResponse | null>(null);

    useEffect(() => {
        let alive = true;
        api.secrets
            .status()
            .then((s) => alive && setStatus(s))
            .catch(() => alive && setAvailable(false));
        return () => {
            alive = false;
        };
    }, []);

    if (!available || !status) return null;

    const migrate = async () => {
        setBusy(true);
        setError(null);
        try {
            const r = await api.secrets.migrate({ confirm: true, plaintextBackups: backups });
            setResult(r);
            setConfirming(false);
            setStatus(await api.secrets.status());
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    const keyLabel =
        status.masterKeySource === 'none' ? t('secrets.keyNone') : t(`secrets.key.${status.masterKeySource}`);

    return (
        <section className="card form" aria-label={t('secrets.title')}>
            <h2>{t('secrets.title')}</h2>
            <dl className="small">
                <dt>{t('secrets.file')}</dt>
                <dd data-testid="secrets-file">{t(`secrets.state.${status.file}`)}</dd>
                <dt>{t('secrets.masterKey')}</dt>
                <dd>
                    {keyLabel}
                    {status.fingerprint ? (
                        <>
                            {' · '}
                            {t('secrets.fingerprint')}{' '}
                            <code data-testid="secrets-fingerprint">{status.fingerprint}</code>
                        </>
                    ) : null}
                </dd>
                <dt>{t('secrets.backups')}</dt>
                <dd>{t('secrets.backupsCount', { total: status.backups.total, plain: status.backups.plaintext })}</dd>
            </dl>

            {status.file === 'encrypted' && !status.keyAvailable ? (
                <p className="error" role="alert">
                    <strong>{t('secrets.unavailable')}</strong> {t('secrets.unavailableHint')}
                </p>
            ) : null}

            {status.file === 'plaintext' && !confirming ? (
                <>
                    <p className="small" role="status">
                        {t('secrets.plaintextHint')}
                    </p>
                    <button type="button" onClick={() => setConfirming(true)}>
                        {t('secrets.migrate')}
                    </button>
                </>
            ) : null}

            {status.file === 'plaintext' && confirming ? (
                <div className="card" role="group" aria-label={t('secrets.confirmTitle')}>
                    <h3>{t('secrets.confirmTitle')}</h3>
                    <ol className="small">
                        <li>{t('secrets.step1')}</li>
                        <li>{t('secrets.step2')}</li>
                        <li>{t('secrets.step3')}</li>
                        <li>{t('secrets.step4')}</li>
                    </ol>
                    {status.backups.plaintext > 0 ? (
                        <label>
                            {t('secrets.plainBackups', { n: status.backups.plaintext })}
                            <select
                                name="plaintextBackups"
                                value={backups}
                                onChange={(e) => {
                                    setBackups(e.target.value as PlaintextBackupAction);
                                    setDeleteConfirmed(false);
                                }}
                            >
                                <option value="keep">{t('secrets.backupsKeep')}</option>
                                <option value="encrypt">{t('secrets.backupsEncrypt')}</option>
                                <option value="delete">{t('secrets.backupsDelete')}</option>
                            </select>
                        </label>
                    ) : null}
                    {backups === 'delete' ? (
                        <label className="inline">
                            <input
                                type="checkbox"
                                name="confirmDelete"
                                checked={deleteConfirmed}
                                onChange={(e) => setDeleteConfirmed(e.target.checked)}
                            />{' '}
                            {t('secrets.deleteConfirm')}
                        </label>
                    ) : null}
                    <p className="small muted">{t('secrets.masterKeyNote')}</p>
                    <span className="row">
                        <button
                            type="button"
                            disabled={busy || (backups === 'delete' && !deleteConfirmed)}
                            onClick={() => void migrate()}
                        >
                            {t('secrets.confirmMigrate')}
                        </button>
                        <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                            {t('nav.cancel')}
                        </button>
                    </span>
                </div>
            ) : null}

            {result ? (
                <p className="small" role="status">
                    {t('secrets.done', { n: result.migratedKeys, fp: result.fingerprint ?? '' })}
                </p>
            ) : null}
            {status.file === 'encrypted' ? <p className="small muted">{t('secrets.cleanupHint')}</p> : null}
            {error ? (
                <p className="small error" role="alert">
                    {error}
                </p>
            ) : null}
        </section>
    );
}
