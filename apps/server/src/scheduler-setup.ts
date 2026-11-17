// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 把通用调度器(ADR 0033)接到服务器:内置系统任务、动作表、主人的时区。
import type { TaskPolicy } from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import type { RunManager } from '@fatcat-ai/agent';
import type { MaintenanceScheduler } from './maintenance-setup.js';
import { MAINTENANCE_CRON } from './maintenance-setup.js';
import { resolveProfile } from './routes/sessions.js';
import { createAgentTaskExecutor } from './scheduler/agent-task.js';
import { ExecutorError, TaskEngine, type Executor } from './scheduler/engine.js';
import { createFileWatcher } from './scheduler/file-watch.js';
import type { SecretStore } from '@fatcat-ai/providers';

export const MAINTENANCE_TASK_KEY = 'memory.maintenance';
export const SLEEP_TASK_KEY = 'memory.sleep';
/** 每天 04:00(用户时区),在维护任务(03:30)之后。 */
export const SLEEP_CRON = '0 4 * * *';

/** 系统任务的默认策略:错过就补跑一次(与旧维护任务启动后补跑一致);系统忙时的重试由引擎的推迟机制负责。 */
const SYSTEM_POLICY: TaskPolicy = { maxAttempts: 3, misfire: 'catchUp', quietHours: null, maxRuntimeMinutes: 30 };

export interface Scheduler {
    engine: TaskEngine;
    /** 为主人补建内置系统任务;有新建时返回 true(调用方应让引擎重新排期)。 */
    ensureSystemTasks(ownerId: string): boolean;
    /** 新邮件事件(只带数量;按账户匹配任务)。 */
    mailReceived(ownerId: string, accountId: string, added: number): void;
    /** 任务或授权目录改变后重新建立文件监听。 */
    syncWatchers(): void;
    stop(): void;
}

export function startScheduler(options: {
    repos: Repositories;
    maintenance: MaintenanceScheduler;
    /** memory.sleep 整理(ADR 0037);没给时该系统任务运行记 config_error。 */
    sleep?: (ownerId: string) => Promise<unknown>;
    timeZone: () => string;
    onError: (error: unknown) => void;
    /** 给了才能运行 agent_prompt 任务(ADR 0034);没有时这类任务记 config_error。 */
    agent?: { runs: RunManager; secrets: SecretStore };
    /** 为 false 时只建任务不排期(测试中使用)。 */
    schedule?: boolean;
}): Scheduler {
    const { repos } = options;
    const executors: Record<string, Executor> = {
        [MAINTENANCE_TASK_KEY]: async ({ task }) => {
            const result = await options.maintenance.runner.runAll(task.ownerId);
            return Object.values(result).includes('postponed') ? 'postponed' : 'succeeded';
        },
    };
    executors[SLEEP_TASK_KEY] = async ({ task }) => {
        if (!options.sleep) throw new ExecutorError('config_error');
        await options.sleep(task.ownerId);
        return 'succeeded';
    };
    if (options.agent) {
        executors.agent_prompt = createAgentTaskExecutor({
            repos,
            runs: options.agent.runs,
            resolveProfile,
            secrets: options.agent.secrets,
        });
    }
    const engine = new TaskEngine({ repos, executors, timeZone: options.timeZone, onError: options.onError });
    const files = createFileWatcher({
        repos,
        onChange: (task, note) => void engine.fireEvent(task.id, note),
        onError: options.onError,
    });
    const scheduler: Scheduler = {
        engine,
        mailReceived(ownerId, accountId, added) {
            for (const task of repos.tasks.list(ownerId)) {
                if (task.trigger.kind !== 'mail_received') continue;
                if (task.trigger.accountId && task.trigger.accountId !== accountId) continue;
                const label = repos.mail.get(ownerId, accountId)?.label ?? 'mail account';
                engine.fireEvent(
                    task.id,
                    `${added} new message(s) arrived in "${label}". Use the mail tools to look at them.`,
                );
            }
        },
        syncWatchers: () => files.sync(),
        ensureSystemTasks(ownerId) {
            const before = repos.tasks.list(ownerId, { kind: 'system' }).length;
            repos.tasks.ensureSystem(ownerId, {
                key: MAINTENANCE_TASK_KEY,
                name: 'Memory maintenance',
                trigger: { kind: 'cron', expression: MAINTENANCE_CRON },
                action: { kind: 'system', key: MAINTENANCE_TASK_KEY },
                policy: SYSTEM_POLICY,
            });
            // 默认关闭:主人在任务页打开后才会整理(ADR 0037)
            repos.tasks.ensureSystem(ownerId, {
                key: SLEEP_TASK_KEY,
                name: 'Memory sleep',
                trigger: { kind: 'cron', expression: SLEEP_CRON },
                action: { kind: 'system', key: SLEEP_TASK_KEY },
                policy: { ...SYSTEM_POLICY, misfire: 'skip' },
                enabled: false,
            });
            return repos.tasks.list(ownerId, { kind: 'system' }).length > before;
        },
        stop() {
            if (watcher) clearInterval(watcher);
            files.stop();
            engine.stop();
        },
    };
    for (const ownerId of repos.owners.ids()) scheduler.ensureSystemTasks(ownerId);
    let watcher: ReturnType<typeof setInterval> | null = null;
    if (options.schedule !== false) {
        engine.start();
        files.sync();
        // 主人账户是首次启动之后才创建的:每分钟补建内置任务并排期(没有新建时什么也不做)
        watcher = setInterval(() => {
            let created = false;
            for (const ownerId of repos.owners.ids()) created = scheduler.ensureSystemTasks(ownerId) || created;
            if (created) engine.rescheduleAll();
        }, 60_000);
        watcher.unref?.();
    }
    return scheduler;
}
