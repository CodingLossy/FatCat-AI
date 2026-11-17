// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆维护任务(ADR 0007 第 5.7 节):decay → tier → expire。M6 起排期、重试、补跑都由通用调度器负责
// (ADR 0033 第 3.2 节,系统任务 memory.maintenance);这里只保留维护运行器与每天固定时刻的轻量任务
// (附件清理、渠道去重表清理)用的 scheduleDaily。
import { createMaintenanceRunner, type MaintenanceRunner } from '@fatcat-ai/memory';
import type { Repositories } from '@fatcat-ai/storage';
import { Cron } from 'croner';

export const MAINTENANCE_CRON = '30 3 * * *';
/** 每天按某个时区的 03:30 运行的任务;改时区时调用 reschedule(ADR 0023 第 5 节)。 */
export interface DailyJob {
    reschedule(timeZone: string): void;
    /** 下一次运行的时刻(测试用);已停止时为 null。 */
    nextRun(): Date | null;
    stop(): void;
}

/**
 * 按 timeZone 的每天 03:30 调用 fn。重新排期只是停掉旧任务、建新任务:已错过的不补跑,
 * 「同一天不跑两次」由各任务自己的日期键保证。
 */
export function scheduleDaily(fn: () => void, timeZone: string): DailyJob {
    let job = new Cron(MAINTENANCE_CRON, { unref: true, timezone: timeZone }, fn);
    return {
        reschedule(next) {
            job.stop();
            job = new Cron(MAINTENANCE_CRON, { unref: true, timezone: next }, fn);
        },
        nextRun: () => job.nextRun(),
        stop: () => job.stop(),
    };
}

export interface MaintenanceScheduler {
    runner: MaintenanceRunner;
    /** 立即为所有 owner 运行一次(测试与手动触发用)。 */
    runNow(): Promise<void>;
}

export function startMaintenance(options: {
    repos: Repositories;
    removeVectors: (itemId: string) => void;
    isBusy: () => boolean;
    onChanged: (ownerId: string) => void;
    onError: (error: unknown) => void;
}): MaintenanceScheduler {
    const runner = createMaintenanceRunner({
        repos: options.repos,
        removeVectors: options.removeVectors,
        isBusy: options.isBusy,
        onChanged: options.onChanged,
    });
    return {
        runner,
        runNow: async () => {
            try {
                for (const ownerId of options.repos.owners.ids()) await runner.runAll(ownerId);
            } catch (error) {
                options.onError(error);
            }
        },
    };
}
