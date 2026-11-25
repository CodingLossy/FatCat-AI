// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置页「密钥」一节(ADR 0026):密钥文件的状态、主密钥来源与指纹、显式迁移。
// 迁移不会自动发生;secrets.yaml.migrated 只能用命令行清理,这里只显示提示文字。
// 「我的密钥」每个账户都有(ADR 0053 第 5 节):只列名字和引用,值只写不读。
import type { PlaintextBackupAction, SecretKey, SecretsMigrateResponse, SecretsStatus } from '@fatcat-ai/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { useIsAdmin } from './role.js';

const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function SecretKeys({ isAdmin }: { isAdmin: boolean | null }) {
    const { t } = useI18n();
    const [keys, setKeys] = useState<SecretKey[] | null>(null);
    const [name, setName] = useState('');
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(
        () =>
            api.secrets.keys.list().then(
                (page) => setKeys(page.items),
                (e: unknown) => setError(errorText(e)),
            ),
        [],
    );
    useEffect(() => {
        void reload();
    }, [reload]);

    const save = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setNote(null);
        try {
            const saved = await api.secrets.keys.save(name.trim(), value);
            setName('');
            setValue('');
            setNote(t('secretKeys.saved', { name: saved.name }));
            await reload();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };
    const remove = async (k: SecretKey) => {
        if (!window.confirm(t('secretKeys.deleteConfirm', { name: k.name }))) return;
        setError(null);
        setNote(null);
        try {
            await api.secrets.keys.remove(k.name);
        } catch (err) {
            setError(errorText(err));
        }
        await reload();
    };

    return (
        <section className="card form" aria-label={t('secretKeys.title')}>
            <h2>{t('secretKeys.title')}</h2>
            <p className="small muted">{t('secretKeys.hint')}</p>
            {isAdmin === false ? <p className="small muted">{t('secretKeys.memberHint')}</p> : null}
            {keys?.length === 0 ? <p className="muted small">{t('secretKeys.empty')}</p> : null}
            {keys && keys.length > 0 ? (
                <ul className="list" data-testid="secret-keys">
                    {keys.map((k) => (
                        <li key={k.name} className="row spread" data-key={k.name}>
                            <span>
                                <strong>{k.name}</strong> <code className="small">{k.ref}</code>
                            </span>
                            <button type="button" className="danger" onClick={() => void remove(k)}>
                                {t('secretKeys.delete')}
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
            <form className="row" onSubmit={(e) => void save(e)} aria-label={t('secretKeys.save')}>
                <label>
                    {t('secretKeys.name')}
                    <input
                        name="secretName"
                        placeholder="OPENAI_API_KEY"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={64}
                        value={name}
                        aria-invalid={name !== '' && !KEY_NAME.test(name.trim())}
                        onChange={(e) => setName(e.target.value)}
                        required
                    />
                </label>
                <label>
                    {t('secretKeys.value')}
                    <input
                        name="secretValue"
                        type="password"
                        autoComplete="new-password"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        required
                    />
                </label>
                <button
                    type="submit"
                    className="primary"
                    disabled={busy || !KEY_NAME.test(name.trim()) || !value.trim()}
                >
                    {t('secretKeys.save')}
                </button>
            </form>
            {note ? (
                <p className="small" role="status">
                    {note}
                </p>
            ) : null}
            {error ? (
                <p className="small error" role="alert">
                    {error}
                </p>
            ) : null}
        </section>
    );
}

export function SecretsSection() {
    const isAdmin = useIsAdmin();
    return (
        <>
            <SecretsFile isAdmin={isAdmin} />
            <SecretKeys isAdmin={isAdmin} />
        </>
    );
}

function SecretsFile({ isAdmin }: { isAdmin: boolean | null }) {
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
        if (isAdmin !== true) return;
        api.secrets
            .status()
            .then((s) => alive && setStatus(s))
            .catch(() => alive && setAvailable(false));
        return () => {
            alive = false;
        };
    }, [isAdmin]);

    // secrets.yaml 整个安装只有一份,只有管理员能看状态和迁移(ADR 0053 第 5 节)
    if (isAdmin === false) {
        return (
            <section className="card form" aria-label={t('secrets.title')}>
                <h2>{t('secrets.title')}</h2>
                <p className="muted small" data-testid="admin-only">
                    {t('admin.onlyNote')}
                </p>
            </section>
        );
    }
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
