// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Channel, Task, TaskDraftResult, TaskRun } from '@fatcat-ai/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';

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
    const [token, setToken] = useState<{ id: string; token: string; url: string } | null>(null);
    const [editing, setEditing] = useState<{
        id: string;
        expression: string;
        preview: string[];
        error: string | null;
    } | null>(null);

    const reload = useCallback(async () => {
        try {
            const page = await api.tasks.list();
            setTasks(page.items);
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
            setDraft(await api.tasks.propose(nl.trim()));
            setNl('');
        });
    };
    const confirmDraft = async () => {
        if (!draft) return;
        await act(async () => {
            await api.tasks.confirm(draft.task.id, draft.task.updatedAt);
            setDraft(null);
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
            setEditing((old) => (old ? { ...old, expression, preview: result.times, error: null } : old));
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

    const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale) : t('tasks.none'));
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
            ? `cron ${task.trigger.expression}`
            : task.trigger.kind === 'once'
              ? `${t('tasks.once')} ${when(task.trigger.at)}`
              : task.trigger.kind === 'mail_received'
                ? t('tasks.triggerMail')
                : task.trigger.kind === 'webhook'
                  ? t('tasks.triggerWebhook')
                  : t('tasks.triggerFile');

    return (
        <div className="page">
            <h1>{t('tasks.title')}</h1>
            <p className="muted small">{t('tasks.hint')}</p>
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
                    <p className="muted">{draft.task.action.kind === 'agent_prompt' ? draft.task.action.prompt : ''}</p>
                    <p className={draft.task.outputs.some((o) => o.kind === 'channel') ? 'warn' : 'muted'}>
                        {draft.task.outputs.some((o) => o.kind === 'channel')
                            ? t('tasks.draftPush')
                            : t('tasks.outputConversation')}
                    </p>
                    {draft.warnings.map((w) => (
                        <p key={w} className="warn">
                            {w}
                        </p>
                    ))}
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
                            {trigger(task)} · {t('tasks.next')}: {when(task.nextRunAt)} · {t('tasks.last')}:{' '}
                            {task.lastRun
                                ? `${t(`tasks.status.${task.lastRun.status}`)} (${when(task.lastRun.createdAt)})`
                                : t('tasks.none')}
                        </p>
                        {detail(task)}
                        <div className="row">
                            <button type="button" onClick={() => void act(() => api.tasks.run(task.id))}>
                                {t('tasks.runNow')}
                            </button>
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
                                        {editing.preview.map((p) => new Date(p).toLocaleString(locale)).join(' · ')}
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
                                                    <td className="small">{when(run.scheduledFor)}</td>
                                                    <td className="small">{t(`tasks.trigger.${run.trigger}`)}</td>
                                                    <td className={run.status === 'failed' ? 'error' : ''}>
                                                        {t(`tasks.status.${run.status}`)}
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
