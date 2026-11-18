// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type {
    PluginDetail,
    PluginEventView,
    PluginPrepared,
    PluginProtection,
    PluginView,
    PluginPermissions,
} from '@fatcat-ai/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { navigate } from './router.js';
import { formatRss, pickText, settingsDraft, settingsValues, type SettingsDraft } from './plugin-ui.js';

/**
 * 插件页(ADR 0040 第 9 节):已安装插件、本地目录安装确认(权限清单与保护程度表)、设置表单、密钥绑定、
 * 内存设置与读数、停止 / 停用、卸载对话框。插件给的所有文字一律按纯文本显示。
 */
export function PluginsPage() {
    const { t, locale } = useI18n();
    const [plugins, setPlugins] = useState<PluginView[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [path, setPath] = useState('');
    const [prepared, setPrepared] = useState<PluginPrepared | null>(null);
    const [accepted, setAccepted] = useState(false);
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState<string | null>(null);

    const reload = useCallback(
        () =>
            api.plugins
                .list()
                .then((page) => setPlugins(page.items))
                .catch((e: unknown) => setError(errorText(e))),
        [],
    );

    useEffect(() => {
        void reload();
    }, [reload]);

    // 有插件在启动时每 2 秒刷新一次状态与读数
    const transient = plugins?.some((p) => p.run.state === 'starting') ?? false;
    useEffect(() => {
        if (!transient) return;
        const timer = setInterval(() => void reload(), 2000);
        return () => clearInterval(timer);
    }, [transient, reload]);

    const act = async (action: () => Promise<unknown>) => {
        setError(null);
        setBusy(true);
        try {
            await action();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
        await reload();
    };

    const prepare = (e: FormEvent) => {
        e.preventDefault();
        void act(async () => {
            setPrepared(await api.plugins.prepareLocal(path.trim()));
            setAccepted(false);
        });
    };

    const install = () => {
        if (!prepared) return;
        void act(async () => {
            const view = await api.plugins.install(prepared.stagingId);
            setPrepared(null);
            setPath('');
            setOpen(view.id);
        });
    };

    return (
        <div className="page" data-page="plugins">
            <h1>{t('plugins.title')}</h1>
            <p className="muted small">{t('plugins.hint')}</p>
            {error ? <p className="error">{error}</p> : null}
            {plugins === null ? <p className="muted">{t('common.loading')}</p> : null}
            {plugins?.length === 0 ? <p className="muted">{t('plugins.empty')}</p> : null}
            <ul className="list">
                {plugins?.map((p) => (
                    <li key={p.id} className="card" data-plugin={p.id}>
                        <PluginCard
                            plugin={p}
                            expanded={open === p.id}
                            busy={busy}
                            onToggle={() => setOpen(open === p.id ? null : p.id)}
                            act={act}
                        />
                    </li>
                ))}
            </ul>

            <h2>{t('plugins.installTitle')}</h2>
            <form className="card form" onSubmit={prepare}>
                <label>
                    {t('plugins.localPath')}
                    <input
                        value={path}
                        onChange={(e) => setPath(e.target.value)}
                        placeholder={t('plugins.localPathHint')}
                        spellCheck={false}
                        required
                    />
                </label>
                <p className="small muted">{t('plugins.localNote')}</p>
                <button type="submit" disabled={busy || path.trim() === ''}>
                    {t('plugins.check')}
                </button>
            </form>

            {prepared ? (
                <section className="card form" data-testid="plugin-confirm">
                    <h3>{t('plugins.confirmTitle', { name: pickText(prepared.manifest.name, locale) })}</h3>
                    <ManifestSummary prepared={prepared} />
                    <h4>{t('plugins.permissions')}</h4>
                    <PermissionList permissions={prepared.manifest.permissions} />
                    <h4>{t('plugins.protections')}</h4>
                    <ProtectionTable rows={prepared.protections} />
                    {prepared.unreviewed ? <p className="warn">{t('plugins.unreviewedWarn')}</p> : null}
                    {prepared.installed ? (
                        <p className="error">
                            {t('plugins.alreadyInstalled', { version: prepared.installed.version })}
                        </p>
                    ) : null}
                    <label className="inline">
                        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
                        {t('plugins.acceptAll')}
                    </label>
                    <div className="row">
                        <button
                            type="button"
                            className="primary"
                            disabled={!accepted || busy || prepared.installed !== null}
                            onClick={install}
                        >
                            {t('plugins.install')}
                        </button>
                        <button type="button" onClick={() => setPrepared(null)}>
                            {t('nav.cancel')}
                        </button>
                    </div>
                </section>
            ) : null}
        </div>
    );
}

function ManifestSummary({ prepared }: { prepared: PluginPrepared }) {
    const { t, locale } = useI18n();
    const m = prepared.manifest;
    return (
        <div>
            <p>{pickText(m.description, locale)}</p>
            <p className="small muted">
                {m.id} · v{m.version} · {m.author} · {m.license}
            </p>
            {m.homepage ? <p className="small muted">{t('plugins.homepage', { url: m.homepage })}</p> : null}
        </div>
    );
}

function PermissionList({ permissions }: { permissions: PluginPermissions }) {
    const { t } = useI18n();
    const none =
        permissions.tools.length === 0 &&
        permissions.net.length === 0 &&
        permissions.secrets.length === 0 &&
        !permissions.items;
    return (
        <div className="small">
            {none ? <p className="muted">{t('plugins.permNone')}</p> : null}
            {permissions.tools.length > 0 ? (
                <>
                    <strong>{t('plugins.permTools')}</strong>
                    <ul>
                        {permissions.tools.map((tool) => (
                            <li key={tool.name}>
                                <code>{tool.name}</code> · {t(`risk.${tool.risk}`)}
                                {tool.sendsData ? ` · ${t('plugins.sendsData')}` : ''}
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
            {permissions.net.length > 0 ? (
                <>
                    <strong>{t('plugins.permNet')}</strong>
                    <ul>
                        {permissions.net.map((d) => (
                            <li key={d}>
                                <code>{d}</code>
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
            {permissions.secrets.length > 0 ? (
                <>
                    <strong>{t('plugins.permSecrets')}</strong>
                    <ul>
                        {permissions.secrets.map((s) => (
                            <li key={s.name}>
                                <code>{s.name}</code>
                                {s.required ? ` · ${t('plugins.required')}` : ''}
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
            {permissions.items ? (
                <>
                    <strong>{t('plugins.permItems')}</strong>
                    <ul>
                        {permissions.items.categories.map((c) => (
                            <li key={c.type}>
                                <code>{c.type}</code>
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
        </div>
    );
}

/** 第 3.5 节的保护程度表:每一行写清楚当前平台上的真实程度。 */
function ProtectionTable({ rows }: { rows: PluginProtection[] }) {
    const { t } = useI18n();
    return (
        <div className="table-scroll">
            <table className="audit-table" data-testid="plugin-protections">
                <tbody>
                    {rows.map((r) => (
                        <tr key={r.key} data-protection={r.key}>
                            <td>{t(`plugins.prot.${r.key}`)}</td>
                            <td>
                                <span className="badge" data-level={r.level}>
                                    {t(`plugins.level.${r.level}`)}
                                </span>
                            </td>
                            <td className="small muted">{r.detail}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function PluginCard({
    plugin,
    expanded,
    busy,
    onToggle,
    act,
}: {
    plugin: PluginView;
    expanded: boolean;
    busy: boolean;
    onToggle: () => void;
    act: (action: () => Promise<unknown>) => Promise<void>;
}) {
    const { t, locale } = useI18n();
    const rss = formatRss(plugin.run.rssBytes);
    return (
        <>
            <div className="row spread">
                <div>
                    <strong>{pickText(plugin.name, locale)}</strong>{' '}
                    <span className="small muted">v{plugin.version}</span>
                    <span className="badge" data-state={plugin.state}>
                        {t(`plugins.state.${plugin.state}`)}
                    </span>
                    {plugin.unreviewed ? <span className="badge">{t('plugins.unreviewed')}</span> : null}
                    <p className="small muted">{pickText(plugin.description, locale)}</p>
                    <p className="small muted">
                        {plugin.id} · {plugin.author} · {plugin.license}
                        {plugin.state === 'enabled' ? ` · ${t(`plugins.run.${plugin.run.state}`)}` : ''}
                        {rss
                            ? ` · ${t('plugins.rss', { rss })}${plugin.run.rssSource === 'self-reported' ? ` (${t('plugins.selfReported')})` : ''}`
                            : ''}
                    </p>
                    {plugin.error ? <p className="small error">{plugin.error}</p> : null}
                </div>
                <div className="row">
                    <button
                        type="button"
                        disabled={busy || plugin.missingSecrets.length > 0}
                        title={plugin.missingSecrets.length > 0 ? t('plugins.bindFirst') : undefined}
                        onClick={() =>
                            void act(() => api.plugins.update(plugin.id, { enabled: plugin.state !== 'enabled' }))
                        }
                    >
                        {plugin.state === 'enabled' ? t('plugins.disable') : t('plugins.enable')}
                    </button>
                    <button
                        type="button"
                        disabled={busy || plugin.state !== 'enabled'}
                        onClick={() => void act(() => api.plugins.stop(plugin.id))}
                    >
                        {t('plugins.stop')}
                    </button>
                    <button type="button" onClick={onToggle} aria-expanded={expanded}>
                        {expanded ? t('plugins.hideManage') : t('plugins.manage')}
                    </button>
                </div>
            </div>
            {expanded ? <PluginManage plugin={plugin} busy={busy} act={act} /> : null}
        </>
    );
}

function PluginManage({
    plugin,
    busy,
    act,
}: {
    plugin: PluginView;
    busy: boolean;
    act: (action: () => Promise<unknown>) => Promise<void>;
}) {
    const { t, locale } = useI18n();
    const [detail, setDetail] = useState<PluginDetail | null>(null);
    const [events, setEvents] = useState<PluginEventView[]>([]);
    const [uninstalling, setUninstalling] = useState(false);
    const [purge, setPurge] = useState(false);

    useEffect(() => {
        let alive = true;
        api.plugins
            .get(plugin.id)
            .then((d) => alive && setDetail(d))
            .catch(() => undefined);
        api.plugins
            .events(plugin.id, { limit: 10 })
            .then((page) => alive && setEvents(page.items))
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, [plugin.id, plugin.state, plugin.updatedAt]);

    return (
        <div className="plugin-manage" data-testid="plugin-manage">
            {plugin.permissions.secrets.length > 0 ? <SecretBindings plugin={plugin} busy={busy} act={act} /> : null}
            {plugin.settingsSchema ? <SettingsForm plugin={plugin} busy={busy} act={act} /> : null}
            <RuntimeForm plugin={plugin} busy={busy} act={act} />
            {plugin.taskTemplates.length > 0 && plugin.state === 'enabled' ? (
                <div data-testid="plugin-templates">
                    <h4>{t('plugins.templatesTitle')}</h4>
                    <p className="small muted">{t('plugins.templatesHint')}</p>
                    <ul className="small">
                        {plugin.taskTemplates.map((template, index) => (
                            <li key={index}>
                                {pickText(template.title, locale)}{' '}
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                        void act(async () => {
                                            await api.tasks.fromPluginTemplate(plugin.id, index);
                                            navigate({ name: 'tasks' });
                                        })
                                    }
                                >
                                    {t('plugins.templateCreate')}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
            <h4>{t('plugins.permissions')}</h4>
            <PermissionList permissions={plugin.permissions} />
            {detail ? (
                <>
                    <h4>{t('plugins.protections')}</h4>
                    <ProtectionTable rows={detail.protections} />
                </>
            ) : null}
            <h4>{t('plugins.events')}</h4>
            {events.length === 0 ? <p className="small muted">{t('plugins.noEvents')}</p> : null}
            <ul className="small">
                {events.map((e) => (
                    <li key={e.id}>
                        {new Date(e.at).toLocaleString(locale)} · {e.kind}
                        {e.detail ? ` · ${e.detail}` : ''}
                    </li>
                ))}
            </ul>
            {uninstalling ? (
                <div
                    className="card"
                    role="alertdialog"
                    aria-labelledby={`un-${plugin.id}`}
                    data-testid="plugin-uninstall"
                >
                    <p id={`un-${plugin.id}`}>
                        <strong>{t('plugins.uninstallTitle', { name: pickText(plugin.name, locale) })}</strong>
                    </p>
                    <p className="small">{t('plugins.uninstallWhat')}</p>
                    {detail && detail.affectedTasks.length > 0 ? (
                        <div className="small" data-testid="plugin-affected-tasks">
                            <p>{t('plugins.affectedTasks')}</p>
                            <ul>
                                {detail.affectedTasks.map((task) => (
                                    <li key={task.id}>{task.name}</li>
                                ))}
                            </ul>
                        </div>
                    ) : (
                        <p className="small muted">{t('plugins.noAffectedTasks')}</p>
                    )}
                    <label className="inline">
                        <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
                        {t('plugins.purgeData')}
                    </label>
                    <p className="small warn">{t('plugins.backupNote')}</p>
                    <div className="row">
                        <button
                            type="button"
                            className="danger"
                            disabled={busy}
                            onClick={() => void act(() => api.plugins.uninstall(plugin.id, purge))}
                        >
                            {t('plugins.uninstall')}
                        </button>
                        <button type="button" onClick={() => setUninstalling(false)}>
                            {t('nav.cancel')}
                        </button>
                    </div>
                </div>
            ) : (
                <button type="button" className="danger" onClick={() => setUninstalling(true)}>
                    {t('plugins.uninstall')}
                </button>
            )}
        </div>
    );
}

type Act = (action: () => Promise<unknown>) => Promise<void>;

function SecretBindings({ plugin, busy, act }: { plugin: PluginView; busy: boolean; act: Act }) {
    const { t } = useI18n();
    const [refs, setRefs] = useState<Record<string, string>>(() => ({ ...plugin.secretRefs }));
    const invalid = (value: string) => value !== '' && !/^env:[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
    const bad = Object.values(refs).some(invalid);
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const changed: Record<string, string> = {};
        for (const [name, ref] of Object.entries(refs))
            if (ref !== '' && ref !== plugin.secretRefs[name]) changed[name] = ref;
        void act(() => api.plugins.update(plugin.id, { secretRefs: changed }));
    };
    return (
        <form className="form" onSubmit={submit} data-testid="plugin-secrets">
            <h4>{t('plugins.secretsTitle')}</h4>
            <p className="small muted">{t('plugins.secretsHint')}</p>
            {plugin.permissions.secrets.map((s) => (
                <label key={s.name}>
                    <span>
                        <code>{s.name}</code>
                        {s.required ? ` · ${t('plugins.required')}` : ''}
                    </span>
                    <input
                        value={refs[s.name] ?? ''}
                        placeholder="env:MY_SERVICE_KEY"
                        aria-label={s.name}
                        spellCheck={false}
                        onChange={(e) => setRefs({ ...refs, [s.name]: e.target.value })}
                    />
                </label>
            ))}
            {bad ? <p className="small error">{t('plugins.secretsInvalid')}</p> : null}
            {plugin.missingSecrets.length > 0 ? (
                <p className="small warn">{t('plugins.secretsMissing', { names: plugin.missingSecrets.join(', ') })}</p>
            ) : null}
            <button type="submit" disabled={busy || bad}>
                {t('plugins.save')}
            </button>
        </form>
    );
}

function SettingsForm({ plugin, busy, act }: { plugin: PluginView; busy: boolean; act: Act }) {
    const { t, locale } = useI18n();
    const schema = plugin.settingsSchema!;
    const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraft(schema, plugin.settings));
    const [invalid, setInvalid] = useState<string[]>([]);
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const result = settingsValues(schema, draft);
        setInvalid(result.invalid);
        if (result.invalid.length === 0) void act(() => api.plugins.update(plugin.id, { settings: result.values }));
    };
    return (
        <form className="form" onSubmit={submit} data-testid="plugin-settings">
            <h4>{t('plugins.settingsTitle')}</h4>
            {Object.entries(schema.properties).map(([key, prop]) => {
                const label = prop.title ? pickText(prop.title, locale) : key;
                const required = schema.required?.includes(key) ?? false;
                const help = prop.description ? (
                    <span className="small muted">{pickText(prop.description, locale)}</span>
                ) : null;
                if (prop.type === 'boolean') {
                    return (
                        <label key={key} className="inline">
                            <input
                                type="checkbox"
                                checked={draft[key] === true}
                                onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
                            />
                            {label}
                            {help}
                        </label>
                    );
                }
                return (
                    <label key={key}>
                        <span>
                            {label}
                            {required ? ' *' : ''}
                        </span>
                        {prop.type === 'string' && prop.enum ? (
                            <select
                                value={String(draft[key] ?? '')}
                                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                            >
                                {required ? null : <option value="" />}
                                {prop.enum.map((v) => (
                                    <option key={v} value={v}>
                                        {v}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <input
                                type={prop.type === 'number' ? 'number' : 'text'}
                                value={String(draft[key] ?? '')}
                                step="any"
                                {...(prop.type === 'number' && prop.minimum !== undefined ? { min: prop.minimum } : {})}
                                {...(prop.type === 'number' && prop.maximum !== undefined ? { max: prop.maximum } : {})}
                                {...(prop.type === 'string' && prop.maxLength !== undefined
                                    ? { maxLength: prop.maxLength }
                                    : {})}
                                required={required}
                                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                            />
                        )}
                        {help}
                    </label>
                );
            })}
            {invalid.length > 0 ? (
                <p className="small error">{t('plugins.settingsInvalid', { keys: invalid.join(', ') })}</p>
            ) : null}
            <button type="submit" disabled={busy}>
                {t('plugins.save')}
            </button>
        </form>
    );
}

/** 单插件的内存设置(第 8 节):V8 堆上限、内存阈值;留空表示不设。读数在卡片上。 */
function RuntimeForm({ plugin, busy, act }: { plugin: PluginView; busy: boolean; act: Act }) {
    const { t } = useI18n();
    const fields = [
        ['maxOldSpaceMiB', 'plugins.runtime.maxOldSpace'],
        ['maxSemiSpaceMiB', 'plugins.runtime.maxSemiSpace'],
        ['memoryThresholdMiB', 'plugins.runtime.threshold'],
    ] as const;
    const [draft, setDraft] = useState<Record<string, string>>(() =>
        Object.fromEntries(
            fields.map(([key]) => [
                key,
                plugin.runtime[key] === undefined || plugin.runtime[key] === null ? '' : String(plugin.runtime[key]),
            ]),
        ),
    );
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const runtime: Record<string, number | null> = {};
        for (const [key] of fields) {
            const raw = (draft[key] ?? '').trim();
            runtime[key] = raw === '' ? null : Number(raw);
        }
        void act(() => api.plugins.update(plugin.id, { runtime }));
    };
    return (
        <form className="form" onSubmit={submit} data-testid="plugin-runtime">
            <h4>{t('plugins.runtimeTitle')}</h4>
            <p className="small muted">{t('plugins.runtimeHint')}</p>
            {fields.map(([key, label]) => (
                <label key={key}>
                    {t(label)}
                    <input
                        type="number"
                        min={1}
                        value={draft[key] ?? ''}
                        placeholder={t('plugins.runtime.unset')}
                        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                    />
                </label>
            ))}
            <button type="submit" disabled={busy}>
                {t('plugins.save')}
            </button>
        </form>
    );
}
