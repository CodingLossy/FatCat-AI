// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆维护任务的调度(ADR 0007 第 5.7 节):croner 每天 03:30(服务器本地时间)运行 decay → tier → expire;
// 推迟时 10 分钟后重试;启动 10 分钟后补跑当天还没做完的任务。M6 的通用调度器上线后迁移过去。
import { createMaintenanceRunner, type MaintenanceRunner } from '@fatcat-ai/memory';
import type { Repositories } from '@fatcat-ai/storage';
import { Cron } from 'croner';

export const MAINTENANCE_CRON = '30 3 * * *';
const RETRY_MS = 10 * 60_000;
const CATCH_UP_MS = 10 * 60_000;
/** 一天之内最多重试的次数,避免一直忙时无限重试。 */
const MAX_RETRIES = 12;

export interface MaintenanceScheduler {
    runner: MaintenanceRunner;
    /** 立即为所有 owner 运行一次(测试与手动触发用)。 */
    runNow(): Promise<void>;
    stop(): void;
}

export function startMaintenance(options: {
    repos: Repositories;
    removeVectors: (itemId: string) => void;
    isBusy: () => boolean;
    onChanged: (ownerId: string) => void;
    onError: (error: unknown) => void;
    /** 为 false 时不安排定时任务(测试中使用)。 */
    schedule?: boolean;
}): MaintenanceScheduler {
    const runner = createMaintenanceRunner({
        repos: options.repos,
        removeVectors: options.removeVectors,
        isBusy: options.isBusy,
        onChanged: options.onChanged,
    });
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;
    let running: Promise<void> | null = null;

    async function runOnce(): Promise<boolean> {
        let postponed = false;
        for (const ownerId of options.repos.owners.ids()) {
            const result = await runner.runAll(ownerId);
            if (Object.values(result).includes('postponed')) postponed = true;
        }
        return postponed;
    }

    function trigger(): Promise<void> {
        running ??= runOnce()
            .then((postponed) => {
                if (postponed && retries < MAX_RETRIES) {
                    retries++;
                    retryTimer = setTimeout(() => void trigger(), RETRY_MS);
                    retryTimer.unref?.();
                } else {
                    retries = 0;
                }
            })
            .catch(options.onError)
            .finally(() => {
                running = null;
            });
        return running;
    }

    const jobs: { stop(): void }[] = [];
    if (options.schedule !== false) {
        jobs.push(new Cron(MAINTENANCE_CRON, { unref: true }, () => void trigger()));
        const catchUp = setTimeout(() => void trigger(), CATCH_UP_MS); // 任务幂等:当天已完成的直接跳过
        catchUp.unref?.();
        jobs.push({ stop: () => clearTimeout(catchUp) });
    }

    return {
        runner,
        runNow: trigger,
        stop() {
            for (const job of jobs) job.stop();
            if (retryTimer) clearTimeout(retryTimer);
        },
    };
}
