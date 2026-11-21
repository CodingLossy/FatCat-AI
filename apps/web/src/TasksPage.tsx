// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Channel, Task, TaskAllowedTool, TaskDraftResult, TaskRun } from '@fatcat-ai/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { PreauthPicker } from './PreauthPicker.js';
import { navigate } from './router.js';
import { parseToolSet, withToolSet } from './toolset.js';
import { formatInTimeZone } from './time-zone.js';

/**
 * 任务页(ADR 0033):列出定时任务(现在只有内置的系统任务)、启用 / 停用、修改 cron 时间、立即运行、
 * 查看运行记录。运行记录只有元数据:状态、错误码、时间。有运行在排队或进行中时每 3 秒刷新一次。
 */
export function TasksPage() {
    const { t, locale } = useI18n();
    const [tasks, setTasks] = useState<Task[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [open, setOpen] = useState<string | null>(null);
    const [runs, setRuns] = useState<TaskRun[]>([]);
    const [channels, setChannels] = useState<Channel[]>([]);
    const [form, setForm] = useState<{
        name: string;
        trigger: 'cron' | 'mail_received' | 'webhook';
        cron: string;
        prompt: string;
        channelId: string;
    } | null>(null);
    const [nl, setNl] = useState('');
    const [draft, setDraft] = useState<TaskDraftResult | null>(null);
    // 确认卡上勾选的预授权;任务编辑页里正在编辑预授权的任务
    const [draftAllowed, setDraftAllowed] = useState<{ allowed: TaskAllowedTool[]; missing: string | null }>({
        allowed: [],
        missing: null,
    });
    // 确认卡上的工具集文字(空 = 不限制)
    const [draftToolSet, setDraftToolSet] = useState('');
    const [preauthEdit, setPreauthEdit] = useState<{
        id: string;
        allowed: TaskAllowedTool[];
        missing: string | null;
    } | null>(null);
    const [token, setToken] = useState<{ id: string; token: string; url: string } | null>(null);
    const [editing, setEditing] = useState<{
        id: string;
        expression: string;
        preview: string[];
        timeZone?: string;
        error: string | null;
    } | null>(null);

    const reload = useCallback(async () => {
        try {
            const page = await api.tasks.list();
            setTasks(page.items);
            // 从插件模板建出的草稿:跳到任务页后显示确认卡(没有确认前不会运行)
            const fromPlugin = page.items.find((task) => task.status === 'draft' && task.policy.fromPlugin);
            if (fromPlugin) setDraft((current) => current ?? { task: fromPlugin, warnings: [], notes: [] });
        } catch (e) {
            setError(errorText(e));
        }
    }, []);

    useEffect(() => {
        void reload();
        api.channels
            .list()
            .then((page) => setChannels(page.items.filter((c) => c.enabled && c.binding)))
            .catch(() => setChannels([]));
    }, [reload]);

    const create = async (e: FormEvent) => {
        e.preventDefault();
        if (!form) return;
        await act(async () => {
            await api.tasks.create({
                name: form.name,
                trigger: form.trigger === 'cron' ? { kind: 'cron', expression: form.cron } : { kind: form.trigger },
                action: { kind: 'agent_prompt', prompt: form.prompt },
                outputs: form.channelId ? [{ kind: 'channel', channelId: form.channelId }] : [{ kind: 'conversation' }],
            });
            setForm(null);
        });
    };

    useEffect(() => {
        if (!open) {
            setRuns([]);
            return;
        }
        let alive = true;
        api.tasks
            .runs(open, { limit: 20 })
            .then((page) => alive && setRuns(page.items))
            .catch((e: unknown) => alive && setError(errorText(e)));
        return () => {
            alive = false;
        };
    }, [open, tasks]);

    const active = tasks?.some((task) => task.lastRun?.status === 'queued' || task.lastRun?.status === 'running');
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => void reload(), 3000);
        return () => clearInterval(timer);
    }, [active, reload]);

    const act = async (action: () => Promise<unknown>) => {
        setError(null);
        try {
            await action();
            await reload();
        } catch (e) {
            setError(errorText(e));
        }
    };

    const propose = async (e: FormEvent) => {
        e.preventDefault();
        if (!nl.trim()) return;
        await act(async () => {
            setDraftAllowed({ allowed: [], missing: null });
            const proposed = await api.tasks.propose(nl.trim());
            setDraftToolSet((proposed.task.policy.toolSet ?? []).join(', '));
            setDraft(proposed);
            setNl('');
        });
    };
    const confirmDraft = async () => {
        if (!draft) return;
        if (draftAllowed.missing) {
            setError(draftAllowed.missing);
            return;
        }
        await act(async () => {
            let version = draft.task.updatedAt;
            const toolSet = parseToolSet(draftToolSet);
            const toolSetChanged =
                JSON.stringify(toolSet ?? null) !== JSON.stringify(draft.task.policy.toolSet ?? null);
            if (draftAllowed.allowed.length > 0 || toolSetChanged) {
                // 先把勾选的预授权与确认过的工具集写进草稿,再用新的版本号确认
                const policy = withToolSet(draft.task.policy, toolSet);
                const updated = await api.tasks.update(draft.task.id, {
                    policy:
                        draftAllowed.allowed.length > 0 ? { ...policy, allowedTools: draftAllowed.allowed } : policy,
                });
                version = updated.updatedAt;
            }
            await api.tasks.confirm(draft.task.id, version);
            setDraft(null);
            setDraftAllowed({ allowed: [], missing: null });
        });
    };
    const discardDraft = async () => {
        if (!draft) return;
        await act(async () => {
            await api.tasks.remove(draft.task.id);
            setDraft(null);
        });
    };

    const startEdit = (task: Task) => {
        if (task.trigger.kind !== 'cron') return;
        setEditing({ id: task.id, expression: task.trigger.expression, preview: [], error: null });
        void previewCron(task.trigger.expression);
    };

    const previewCron = async (expression: string) => {
        try {
            const result = await api.tasks.schedulePreview(expression, 3);
            setEditing((old) =>
                old ? { ...old, expression, preview: result.times, timeZone: result.timeZone, error: null } : old,
            );
        } catch (e) {
            setEditing((old) => (old ? { ...old, expression, preview: [], error: errorText(e) } : old));
        }
    };

    const save = async (e: FormEvent) => {
        e.preventDefault();
        if (!editing || editing.error) return;
        await act(async () => {
            await api.tasks.update(editing.id, { trigger: { kind: 'cron', expression: editing.expression } });
            setEditing(null);
        });
    };

    /** 按任务时区显示时刻;浏览器时区不同时附本地时间(例如手机在北京、任务按洛杉矶算)。 */
    const when = (iso: string | null, timeZone?: string) => {
        if (!iso) return t('tasks.none');
        const { main, local } = formatInTimeZone(iso, timeZone, locale);
        return local ? `${main} (${t('tasks.localTime', { time: local })})` : main;
    };
    const runStatusText = (run: TaskRun) =>
        run.waitingApproval ? t('tasks.status.waiting') : t(`tasks.status.${run.status}`);
    const waitingText = (run: TaskRun, timeZone?: string) =>
        t('tasks.waiting', {
            n: run.waitingApproval?.count ?? 0,
            time: when(run.waitingApproval?.expiresAt ?? null, timeZone),
        });
    /** 打开这次运行的对话(审批卡片在里面,也在顶部审批面板里)。 */
    const openRun = (run: TaskRun) => {
        if (run.sessionId) navigate({ name: 'session', id: run.sessionId });
    };
    const name = (task: Task) =>
        task.action.kind === 'system' && task.action.key === 'memory.maintenance'
            ? t('tasks.system.memory.maintenance')
            : task.action.kind === 'system' && task.action.key === 'memory.sleep'
              ? t('tasks.system.memory.sleep')
              : task.name;
    const detail = (task: Task) =>
        task.action.kind === 'agent_prompt' ? (
            <p className="small">
                {task.action.prompt}
                {task.outputs.some((o) => o.kind === 'channel') ? ` · ${t('tasks.pushNote')}` : ''}
            </p>
        ) : null;
    const trigger = (task: Task) =>
        task.trigger.kind === 'cron'
            ? `cron ${task.trigger.expression}${task.timeZone ? ` (${t('tasks.timeZoneLabel', { tz: task.timeZone })})` : ''}`
            : task.trigger.kind === 'once'
              ? `${t('tasks.once')} ${when(task.trigger.at, task.timeZone)}`
              : task.trigger.kind === 'mail_received'
                ? t('tasks.triggerMail')
                : task.trigger.kind === 'webhook'
                  ? t('tasks.triggerWebhook')
                  : t('tasks.triggerFile');

    return (
        <div className="page">
            <h1>{t('tasks.title')}</h1>
            {error ? <p className="error">{error}</p> : null}
            {!form && !draft ? (
                <form className="card task-card" onSubmit={(e) => void propose(e)}>
                    <label>
                        {t('tasks.nl')}
                        <input
                            value={nl}
                            maxLength={500}
                            placeholder={t('tasks.nlPlaceholder')}
                            onChange={(e) => setNl(e.target.value)}
                        />
                    </label>
                    <button type="submit" disabled={!nl.trim()}>
                        {t('tasks.nlSubmit')}
                    </button>
                </form>
            ) : null}
            {draft ? (
                <div className="card task-card" data-testid="task-draft">
                    <h2>{t('tasks.draftTitle')}</h2>
                    <p>
                        <strong>{draft.task.name}</strong> · {trigger(draft.task)}
                    </p>
                    {draft.task.policy.fromPlugin ? (
                        <p className="warn" data-testid="draft-from-plugin">
                            {t('tasks.draftFromPlugin', { plugin: draft.task.policy.fromPlugin })}
                        </p>
                    ) : null}
                    <p className="muted">{draft.task.action.kind === 'agent_prompt' ? draft.task.action.prompt : ''}</p>
                    {draft.task.outputs.some((o) => o.kind === 'channel') ? null : (
                        <p className="muted">{t('tasks.outputConversation')}</p>
                    )}
                    {/* 新服务器给提示码(本地化);旧服务器只有英文 warnings,回退显示 */}
                    {(draft.notes ?? []).map((n) => (
                        <p key={n.code} className="warn">
                            {n.code === 'push_channel'
                                ? t('tasks.note.push_channel', { name: n.channel ?? '' })
                                : t(`tasks.note.${n.code}`)}
                        </p>
                    ))}
                    {draft.notes === undefined
                        ? draft.warnings.map((w) => (
                              <p key={w} className="warn">
                                  {w}
                              </p>
                          ))
                        : null}
                    <PreauthPicker
                        initial={[]}
                        onChange={(allowed, missing) => setDraftAllowed({ allowed, missing })}
                    />
                    <label className="toolset" data-testid="toolset-editor">
                        {t('tasks.toolset.title')}
                        <input
                            value={draftToolSet}
                            placeholder={t('tasks.toolset.placeholder')}
                            aria-label={t('tasks.toolset.title')}
                            onChange={(e) => setDraftToolSet(e.target.value)}
                        />
                    </label>
                    <p className="small muted">
                        {draft.task.policy.toolSet ? t('tasks.toolset.suggested') : t('tasks.toolset.hint')}
                    </p>
                    <p className="muted small">{t('tasks.draftNotice')}</p>
                    <button type="button" onClick={() => void confirmDraft()}>
                        {t('tasks.draftConfirm')}
                    </button>{' '}
                    <button type="button" className="secondary" onClick={() => void discardDraft()}>
                        {t('tasks.draftDiscard')}
                    </button>
                </div>
            ) : null}
            {form ? (
                <form className="card task-card" onSubmit={(e) => void create(e)}>
                    <label>
                        {t('tasks.name')}
                        <input
                            value={form.name}
                            onChange={(e) => setForm({ ...form, name: e.target.value })}
                            required
                            maxLength={80}
                        />
                    </label>
                    <label>
                        {t('tasks.cron')}
                        <input
                            value={form.cron}
                            onChange={(e) => setForm({ ...form, cron: e.target.value })}
                            required
                        />
                    </label>
                    <p className="small muted">{t('tasks.cronHint')}</p>
                    <label>
                        {t('tasks.prompt')}
                        <textarea
                            value={form.prompt}
                            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                            required
                            maxLength={2000}
                            rows={4}
                        />
                    </label>
                    <label>
                        {t('tasks.output')}
                        <select
                            value={form.channelId}
                            onChange={(e) => setForm({ ...form, channelId: e.target.value })}
                        >
                            <option value="">{t('tasks.outputConversation')}</option>
                            {channels.map((c) => (
                                <option key={c.id} value={c.id}>
                                    {t('tasks.outputChannel', { name: c.label })}
                                </option>
                            ))}
                        </select>
                    </label>
                    {form.channelId ? <p className="small muted">{t('tasks.outputChannelHint')}</p> : null}
                    <div className="row">
                        <button type="submit">{t('tasks.create')}</button>
                        <button type="button" onClick={() => setForm(null)}>
                            {t('nav.cancel')}
                        </button>
                    </div>
                </form>
            ) : (
                <button
                    type="button"
                    onClick={() => setForm({ name: '', trigger: 'cron', cron: '0 8 * * *', prompt: '', channelId: '' })}
                >
                    {t('tasks.new')}
                </button>
            )}
            {tasks === null ? <p className="muted">{t('common.loading')}</p> : null}
            {tasks?.length === 0 ? <p className="muted">{t('tasks.empty')}</p> : null}
            {tasks
                ?.filter((task) => task.status !== 'draft')
                .map((task) => (
                    <section key={task.id} className="card task-card" data-task={task.id}>
                        <div className="task-head">
                            <strong>{name(task)}</strong>
                            {task.kind === 'system' ? <span className="badge">{t('tasks.systemBadge')}</span> : null}
                            <label className="task-toggle">
                                <input
                                    type="checkbox"
                                    checked={task.enabled}
                                    onChange={(e) =>
                                        void act(() => api.tasks.update(task.id, { enabled: e.target.checked }))
                                    }
                                />{' '}
                                {t('tasks.enabled')}
                            </label>
                        </div>
                        <p className="small muted">
                            {trigger(task)} · {t('tasks.next')}: {when(task.nextRunAt, task.timeZone)} ·{' '}
                            {t('tasks.last')}:{' '}
                            {task.lastRun
                                ? `${runStatusText(task.lastRun)} (${when(task.lastRun.createdAt, task.timeZone)})`
                                : t('tasks.none')}
                        </p>
                        {task.lastRun?.waitingApproval ? (
                            <p className="small">
                                <span className="run-waiting">{waitingText(task.lastRun, task.timeZone)}</span>{' '}
                                <button type="button" className="link" onClick={() => openRun(task.lastRun!)}>
                                    {t('tasks.approveNow')}
                                </button>
                            </p>
                        ) : null}
                        {task.disabledReason ? (
                            <p className="small warn" data-testid="task-disabled-reason">
                                {t(`tasks.disabledReason.${task.disabledReason}`)}
                            </p>
                        ) : null}
                        {task.warning ? <p className="small error">{t(`tasks.warning.${task.warning}`)}</p> : null}
                        {task.lastRun?.errorCode === 'over_budget' ? (
                            <p className="small muted">{t('tasks.error.over_budget')}</p>
                        ) : null}
                        {detail(task)}
                        <div className="row">
                            <button type="button" onClick={() => void act(() => api.tasks.run(task.id))}>
                                {t('tasks.runNow')}
                            </button>
                            {task.action.kind === 'agent_prompt' ? (
                                <button
                                    type="button"
                                    onClick={() =>
                                        setPreauthEdit(
                                            preauthEdit?.id === task.id
                                                ? null
                                                : {
                                                      id: task.id,
                                                      allowed: task.policy.allowedTools ?? [],
                                                      missing: null,
                                                  },
                                        )
                                    }
                                >
                                    {t('tasks.preauth.edit')}
                                </button>
                            ) : null}
                            {task.trigger.kind === 'cron' ? (
                                <button type="button" onClick={() => startEdit(task)}>
                                    {t('tasks.editSchedule')}
                                </button>
                            ) : null}
                            {task.trigger.kind === 'webhook' ? (
                                <button
                                    type="button"
                                    onClick={() =>
                                        void act(async () =>
                                            setToken({ id: task.id, ...(await api.tasks.webhookToken(task.id)) }),
                                        )
                                    }
                                >
                                    {t('tasks.webhookToken')}
                                </button>
                            ) : null}
                            {task.kind === 'user' ? (
                                <button type="button" onClick={() => void act(() => api.tasks.remove(task.id))}>
                                    {t('tasks.delete')}
                                </button>
                            ) : null}
                            <button type="button" onClick={() => setOpen(open === task.id ? null : task.id)}>
                                {open === task.id ? t('tasks.hideRuns') : t('tasks.showRuns')}
                            </button>
                        </div>
                        {token?.id === task.id ? (
                            <p className="small">
                                {t('tasks.webhookShown')} <code>{token.token}</code> · POST {token.url}
                            </p>
                        ) : null}
                        {preauthEdit?.id === task.id ? (
                            <div className="task-edit">
                                <PreauthPicker
                                    initial={task.policy.allowedTools ?? []}
                                    onChange={(allowed, missing) => setPreauthEdit({ id: task.id, allowed, missing })}
                                />
                                <div className="row">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (preauthEdit.missing) {
                                                setError(preauthEdit.missing);
                                                return;
                                            }
                                            void act(async () => {
                                                await api.tasks.update(task.id, {
                                                    policy: { ...task.policy, allowedTools: preauthEdit.allowed },
                                                });
                                                setPreauthEdit(null);
                                            });
                                        }}
                                    >
                                        {t('tasks.preauth.save')}
                                    </button>
                                    <button type="button" onClick={() => setPreauthEdit(null)}>
                                        {t('nav.cancel')}
                                    </button>
                                </div>
                            </div>
                        ) : null}
                        {editing?.id === task.id ? (
                            <form className="task-edit" onSubmit={(e) => void save(e)}>
                                <label>
                                    {t('tasks.cron')}
                                    <input
                                        value={editing.expression}
                                        onChange={(e) => void previewCron(e.target.value)}
                                        aria-label={t('tasks.cron')}
                                    />
                                </label>
                                <p className="small muted">{t('tasks.cronHint')}</p>
                                {editing.error ? <p className="error small">{editing.error}</p> : null}
                                {editing.preview.length > 0 ? (
                                    <p className="small">
                                        {t('tasks.preview')}:{' '}
                                        {editing.preview.map((p) => when(p, editing.timeZone)).join(' · ')}
                                    </p>
                                ) : null}
                                <div className="row">
                                    <button
                                        type="submit"
                                        disabled={editing.error !== null || editing.expression.trim() === ''}
                                    >
                                        {t('tasks.save')}
                                    </button>
                                    <button type="button" onClick={() => setEditing(null)}>
                                        {t('nav.cancel')}
                                    </button>
                                </div>
                            </form>
                        ) : null}
                        {open === task.id ? (
                            runs.length === 0 ? (
                                <p className="muted small">{t('tasks.noRuns')}</p>
                            ) : (
                                <div className="table-scroll">
                                    <table className="audit-table">
                                        <thead>
                                            <tr>
                                                <th>{t('tasks.runTime')}</th>
                                                <th>{t('tasks.runTrigger')}</th>
                                                <th>{t('tasks.runStatus')}</th>
                                                <th>{t('tasks.runDuration')}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {runs.map((run) => (
                                                <tr key={run.id} data-status={run.status}>
                                                    <td className="small">{when(run.scheduledFor, task.timeZone)}</td>
                                                    <td className="small">{t(`tasks.trigger.${run.trigger}`)}</td>
                                                    <td className={run.status === 'failed' ? 'error' : ''}>
                                                        {run.waitingApproval ? (
                                                            <span className="run-waiting" data-testid="run-waiting">
                                                                {waitingText(run, task.timeZone)}
                                                            </span>
                                                        ) : (
                                                            t(`tasks.status.${run.status}`)
                                                        )}
                                                        {run.sessionId ? (
                                                            <div>
                                                                <button
                                                                    type="button"
                                                                    className="link small"
                                                                    onClick={() => openRun(run)}
                                                                >
                                                                    {t('tasks.openSession')}
                                                                </button>
                                                            </div>
                                                        ) : null}
                                                        {run.errorCode ? (
                                                            <div className="small">
                                                                {t(`tasks.error.${run.errorCode}`)}
                                                            </div>
                                                        ) : null}
                                                        {run.status === 'queued' || run.status === 'running' ? (
                                                            <button
                                                                type="button"
                                                                className="link"
                                                                onClick={() =>
                                                                    void act(() => api.tasks.cancelRun(run.id))
                                                                }
                                                            >
                                                                {t('tasks.cancelRun')}
                                                            </button>
                                                        ) : null}
                                                    </td>
                                                    <td className="small">
                                                        {run.startedAt && run.finishedAt
                                                            ? `${Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))} s`
                                                            : '—'}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )
                        ) : null}
                    </section>
                ))}
        </div>
    );
}
