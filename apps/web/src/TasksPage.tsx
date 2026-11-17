// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Task, TaskRun } from '@fatcat-ai/shared';
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
    }, [reload]);

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
            : task.name;
    const trigger = (task: Task) =>
        task.trigger.kind === 'cron'
            ? `cron ${task.trigger.expression}`
            : `${t('tasks.once')} ${when(task.trigger.at)}`;

    return (
        <div className="page">
            <h1>{t('tasks.title')}</h1>
            <p className="muted small">{t('tasks.hint')}</p>
            {error ? <p className="error">{error}</p> : null}
            {tasks === null ? <p className="muted">{t('common.loading')}</p> : null}
            {tasks?.length === 0 ? <p className="muted">{t('tasks.empty')}</p> : null}
            {tasks?.map((task) => (
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
                    <div className="row">
                        <button type="button" onClick={() => void act(() => api.tasks.run(task.id))}>
                            {t('tasks.runNow')}
                        </button>
                        {task.trigger.kind === 'cron' ? (
                            <button type="button" onClick={() => startEdit(task)}>
                                {t('tasks.editSchedule')}
                            </button>
                        ) : null}
                        <button type="button" onClick={() => setOpen(open === task.id ? null : task.id)}>
                            {open === task.id ? t('tasks.hideRuns') : t('tasks.showRuns')}
                        </button>
                    </div>
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
                                                        <div className="small">{t(`tasks.error.${run.errorCode}`)}</div>
                                                    ) : null}
                                                    {run.status === 'queued' || run.status === 'running' ? (
                                                        <button
                                                            type="button"
                                                            className="link"
                                                            onClick={() => void act(() => api.tasks.cancelRun(run.id))}
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
