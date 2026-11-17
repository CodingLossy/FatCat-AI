// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 调度的纯时间计算(ADR 0033 第 3 节):cron 下一次、静默时段、重试间隔。不读数据库,不启动定时器。
import type { TaskQuietHours, TaskTrigger } from '@fatcat-ai/shared';
import { Cron } from 'croner';

export const MIN_INTERVAL_MS = 60_000;
/** 可重试失败的间隔:第 1、2、3 次重试分别等 1、5、15 分钟,之后保持 15 分钟。 */
const RETRY_MINUTES = [1, 5, 15];

export type CronProblem = { code: 'fields' | 'never' | 'interval' | 'invalid'; message: string };

/** 5 段 cron 的校验:返回 null 表示合法,否则给出稳定的问题码(界面据此本地化)和英文说明。最小间隔 1 分钟,不接受秒级与别名。 */
export function cronProblem(expression: string, timeZone: string): CronProblem | null {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return { code: 'fields', message: 'a cron expression must have exactly 5 fields' };
    try {
        const cron = new Cron(expression, { timezone: timeZone, paused: true });
        const runs = cron.nextRuns(3, new Date('2026-01-01T00:00:00Z'));
        if (runs.length === 0) return { code: 'never', message: 'the expression never fires' };
        for (let i = 1; i < runs.length; i++) {
            if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_INTERVAL_MS)
                return { code: 'interval', message: 'the minimum interval is 1 minute' };
        }
        return null;
    } catch (error) {
        return { code: 'invalid', message: error instanceof Error ? error.message : 'invalid cron expression' };
    }
}

/** 同 cronProblem,只返回一行英文原因(null 表示合法)。 */
export function validateCron(expression: string, timeZone: string): string | null {
    return cronProblem(expression, timeZone)?.message ?? null;
}

/** 触发器在 after 之后(不含)的下一次时刻;once 在 at 已过或已触发时为 null。 */
export function nextTriggerTime(trigger: TaskTrigger, timeZone: string, after: Date): Date | null {
    if (trigger.kind === 'once') {
        const at = new Date(trigger.at);
        return at.getTime() > after.getTime() ? at : null;
    }
    if (trigger.kind !== 'cron') return null; // 事件触发器没有「下一次」
    return new Cron(trigger.expression, { timezone: timeZone, paused: true }).nextRun(after);
}

/** cron 的接下来 count 次(预览用)。 */
export function previewCron(expression: string, timeZone: string, from: Date, count: number): Date[] {
    return new Cron(expression, { timezone: timeZone, paused: true }).nextRuns(count, from);
}

function localMinutes(at: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return get('hour') * 60 + get('minute');
}

const toMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** at 是否落在静默时段内(用户时区,起点含、终点不含,可跨午夜;起止相同表示没有静默)。 */
export function inQuietHours(at: Date, quiet: Pick<TaskQuietHours, 'start' | 'end'>, timeZone: string): boolean {
    const start = toMinutes(quiet.start);
    const end = toMinutes(quiet.end);
    if (start === end) return false;
    const now = localMinutes(at, timeZone);
    return start < end ? now >= start && now < end : now >= start || now < end;
}

/** 静默时段结束的下一个时刻(用来把推迟的运行放到静默结束后)。 */
export function quietEnd(at: Date, quiet: Pick<TaskQuietHours, 'end'>, timeZone: string): Date {
    const minutes = toMinutes(quiet.end);
    const expression = `${minutes % 60} ${Math.floor(minutes / 60)} * * *`;
    return new Cron(expression, { timezone: timeZone, paused: true }).nextRun(at) ?? at;
}

/** 第 attempt 次(从 1 起)失败之后到下一次重试的等待毫秒数。 */
export function retryDelayMs(attempt: number): number {
    const minutes = RETRY_MINUTES[Math.min(attempt, RETRY_MINUTES.length) - 1] ?? 15;
    return minutes * 60_000;
}
