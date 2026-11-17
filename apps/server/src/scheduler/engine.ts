// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 通用任务调度器(ADR 0033 第 3、4 节)。只有一个定时器指向「最近的下一次触发」;
// 每次触发先写 task_runs 再执行,崩溃后启动时把未结束的记录标为已取消并按错过策略处理。
// 时间来自注入的 now(),定时器用全局 setTimeout(测试用 vitest 的假时钟)。
import type { TaskErrorCode, TaskRunTrigger } from '@fatcat-ai/shared';
import type { Repositories, TaskRecord, TaskRunRecord } from '@fatcat-ai/storage';
import { inQuietHours, nextTriggerTime, quietEnd, retryDelayMs } from './time.js';

/** 动作执行结果:postponed 表示「系统忙,稍后再试」(不消耗重试次数)。 */
export type ExecutorResult = 'succeeded' | 'postponed';

export class ExecutorError extends Error {
    constructor(
        readonly code: TaskErrorCode,
        /** 是否值得重试(超时、网络错误);审批被拒绝、配置错误不重试。 */
        readonly retryable = false,
    ) {
        super(code);
    }
}

export type Executor = (ctx: { task: TaskRecord; run: TaskRunRecord; signal: AbortSignal }) => Promise<ExecutorResult>;

export interface EngineOptions {
    repos: Repositories;
    /** 内置系统任务的动作,按 action.key 查找。 */
    executors: Record<string, Executor>;
    timeZone: () => string;
    now?: () => Date;
    maxConcurrency?: number;
    queueLimit?: number;
    /** 推迟(系统忙)后的重试间隔与上限,与旧的维护任务一致:10 分钟、最多 12 次。 */
    postponeMs?: number;
    postponeMax?: number;
    /** 落后超过这个时间才触发的任务(休眠、卡顿)按错过处理。 */
    lateToleranceMs?: number;
    /** 错过窗口:更久以前错过的触发一律当 skip。 */
    missedWindowMs?: number;
    /** 启动后补跑的延迟。 */
    catchUpDelayMs?: number;
    keepRuns?: number;
    onError: (error: unknown) => void;
    onRunChanged?: (run: TaskRunRecord) => void;
}

interface Pending {
    run: TaskRunRecord;
    task: TaskRecord;
}

export class TaskEngine {
    private readonly now: () => Date;
    private readonly maxConcurrency: number;
    private readonly queueLimit: number;
    private readonly postponeMs: number;
    private readonly postponeMax: number;
    private readonly lateToleranceMs: number;
    private readonly missedWindowMs: number;
    private readonly catchUpDelayMs: number;
    private readonly keepRuns: number;
    private readonly next = new Map<string, Date>();
    private readonly queue: Pending[] = [];
    private readonly running = new Map<string, { controller: AbortController; run: TaskRunRecord }>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private readonly deferred = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly postponed = new Map<string, number>();
    private tick: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;

    constructor(private readonly options: EngineOptions) {
        this.now = options.now ?? (() => new Date());
        this.maxConcurrency = options.maxConcurrency ?? 2;
        this.queueLimit = options.queueLimit ?? 20;
        this.postponeMs = options.postponeMs ?? 10 * 60_000;
        this.postponeMax = options.postponeMax ?? 12;
        this.lateToleranceMs = options.lateToleranceMs ?? 5 * 60_000;
        this.missedWindowMs = options.missedWindowMs ?? 24 * 3_600_000;
        this.catchUpDelayMs = options.catchUpDelayMs ?? 10 * 60_000;
        this.keepRuns = options.keepRuns ?? 200;
    }

    /** 启动:把上次未结束的记录标为已取消,处理错过的触发,然后开始排期。 */
    start(): void {
        const { repos } = this.options;
        repos.tasks.interruptUnfinished();
        const now = this.now();
        for (const task of repos.tasks.listActive()) this.handleMisfire(task, now);
        this.rescheduleAll();
    }

    /** 时区或任务改变后:重新计算每个任务的下一次时刻。 */
    rescheduleAll(): void {
        if (this.stopped) return;
        this.next.clear();
        const now = this.now();
        const tz = this.options.timeZone();
        for (const task of this.options.repos.tasks.listActive()) {
            const next = nextTriggerTime(task.trigger, tz, now);
            if (next) this.next.set(task.id, next);
        }
        this.arm();
    }

    nextRun(taskId: string): Date | null {
        return this.next.get(taskId) ?? null;
    }

    /** 手动运行:同一任务已有排队或运行中的记录时返回 null(调用方回 409)。 */
    runNow(taskId: string): TaskRunRecord | null {
        const task = this.options.repos.tasks.getById(taskId);
        if (!task) return null;
        return this.enqueue(task, this.now(), 'manual');
    }

    /** 取消排队中或运行中的记录;返回是否找到。 */
    cancel(runId: string): boolean {
        const queued = this.queue.findIndex((p) => p.run.id === runId);
        if (queued >= 0) {
            const [pending] = this.queue.splice(queued, 1);
            this.finish(pending!.run, 'cancelled', 'cancelled');
            return true;
        }
        const active = this.running.get(runId);
        if (active) {
            active.controller.abort();
            return true;
        }
        return false;
    }

    /** 停止排期并中止运行中的任务;排队中和运行中的记录标为已取消。 */
    stop(): void {
        this.stopped = true;
        if (this.tick) clearTimeout(this.tick);
        for (const t of this.timers) clearTimeout(t);
        for (const t of this.deferred.values()) clearTimeout(t);
        this.timers.clear();
        this.deferred.clear();
        for (const { run } of this.queue.splice(0)) this.finish(run, 'cancelled', 'cancelled');
        for (const { controller } of this.running.values()) controller.abort();
    }

    // ---- 排期 ----

    private arm(): void {
        if (this.tick) clearTimeout(this.tick);
        this.tick = null;
        if (this.stopped || this.next.size === 0) return;
        const earliest = Math.min(...[...this.next.values()].map((d) => d.getTime()));
        // 最长睡 5 分钟再检查一次:设备休眠醒来后不会等到很久以后的定时器
        const delay = Math.min(Math.max(earliest - this.now().getTime(), 0), 5 * 60_000);
        this.tick = setTimeout(() => this.onTick(), delay);
        this.tick.unref?.();
    }

    private onTick(): void {
        this.tick = null;
        const now = this.now();
        const tz = this.options.timeZone();
        for (const [id, due] of [...this.next]) {
            if (due.getTime() > now.getTime()) continue;
            const task = this.options.repos.tasks.getById(id);
            this.next.delete(id);
            if (!task || task.status !== 'active' || !task.enabled) continue;
            try {
                if (now.getTime() - due.getTime() > this.lateToleranceMs) {
                    this.handleLate(task, due, now);
                } else {
                    this.fire(task, due, 'schedule');
                }
            } catch (error) {
                this.options.onError(error);
            }
            this.advance(task, now, tz);
        }
        this.arm();
    }

    /** 触发过之后的下一步:cron 排下一次;once 标为已完成。 */
    private advance(task: TaskRecord, now: Date, tz: string): void {
        if (task.trigger.kind === 'once') {
            this.options.repos.tasks.update(task.ownerId, task.id, { status: 'completed' });
            return;
        }
        const next = nextTriggerTime(task.trigger, tz, now);
        if (next) this.next.set(task.id, next);
    }

    /** 休眠或卡顿后才醒来:这一次已经错过了。 */
    private handleLate(task: TaskRecord, due: Date, now: Date): void {
        const withinWindow = now.getTime() - due.getTime() <= this.missedWindowMs;
        if (task.policy.misfire === 'catchUp' && withinWindow) this.fire(task, due, 'catch_up');
        else this.recordSkipped(task, due, 'missed');
    }

    /** 启动时检查关闭期间错过的触发(只补一次,不论错过几次)。 */
    private handleMisfire(task: TaskRecord, now: Date): void {
        const tz = this.options.timeZone();
        const since = new Date(task.lastFiredAt ?? task.createdAt);
        const missed = nextTriggerTime(task.trigger, tz, since);
        if (task.trigger.kind === 'once') {
            if (task.lastFiredAt !== null) return;
            const at = new Date(task.trigger.at);
            if (at.getTime() > now.getTime()) return;
            if (task.policy.misfire === 'catchUp') this.afterDelay(task, at, 'catch_up');
            else {
                this.recordSkipped(task, at, 'missed');
                this.options.repos.tasks.update(task.ownerId, task.id, { status: 'completed' });
            }
            return;
        }
        if (!missed || missed.getTime() > now.getTime()) return;
        const withinWindow = now.getTime() - missed.getTime() <= this.missedWindowMs;
        if (task.policy.misfire === 'catchUp' && withinWindow) this.afterDelay(task, missed, 'catch_up');
        else this.recordSkipped(task, missed, 'missed');
    }

    private afterDelay(task: TaskRecord, scheduledFor: Date, reason: TaskRunTrigger): void {
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            try {
                this.fire(task, scheduledFor, reason);
                if (task.trigger.kind === 'once') {
                    this.options.repos.tasks.update(task.ownerId, task.id, { status: 'completed' });
                    this.next.delete(task.id);
                }
            } catch (error) {
                this.options.onError(error);
            }
        }, this.catchUpDelayMs);
        timer.unref?.();
        this.timers.add(timer);
    }

    // ---- 触发与队列 ----

    private fire(task: TaskRecord, scheduledFor: Date, reason: TaskRunTrigger): void {
        this.options.repos.tasks.markFired(task.id, scheduledFor.toISOString());
        const quiet = task.policy.quietHours;
        const tz = this.options.timeZone();
        const now = this.now();
        if (quiet && inQuietHours(now, quiet, tz)) {
            if (quiet.behavior === 'skip') {
                this.recordSkipped(task, scheduledFor, 'quiet_hours');
            } else if (!this.deferred.has(task.id)) {
                // 推迟到静默结束后:同一任务多次合并为一次
                const wait = Math.max(quietEnd(now, quiet, tz).getTime() - now.getTime(), 0);
                const timer = setTimeout(() => {
                    this.deferred.delete(task.id);
                    try {
                        const fresh = this.options.repos.tasks.getById(task.id);
                        if (fresh && fresh.enabled && fresh.status !== 'completed') {
                            this.enqueue(fresh, scheduledFor, reason);
                        }
                    } catch (error) {
                        this.options.onError(error);
                    }
                }, wait);
                timer.unref?.();
                this.deferred.set(task.id, timer);
            }
            return;
        }
        this.enqueue(task, scheduledFor, reason);
    }

    private recordSkipped(task: TaskRecord, scheduledFor: Date, code: TaskErrorCode): void {
        const run = this.options.repos.tasks.createRun({
            taskId: task.id,
            trigger: 'schedule',
            scheduledFor: scheduledFor.toISOString(),
            status: 'skipped',
        });
        this.finish(run, 'skipped', code);
    }

    private enqueue(task: TaskRecord, scheduledFor: Date, reason: TaskRunTrigger): TaskRunRecord | null {
        const { repos } = this.options;
        const busyWithTask =
            this.queue.some((p) => p.task.id === task.id) ||
            [...this.running.values()].some((r) => r.run.taskId === task.id);
        if (busyWithTask) {
            if (reason === 'manual') return null;
            this.recordSkipped(task, scheduledFor, 'overlap');
            return null;
        }
        if (this.queue.length >= this.queueLimit) {
            const dropped = this.queue.shift()!;
            this.finish(dropped.run, 'skipped', 'queue_full');
        }
        const run = repos.tasks.createRun({
            taskId: task.id,
            trigger: reason,
            scheduledFor: scheduledFor.toISOString(),
        });
        this.queue.push({ run, task });
        this.options.onRunChanged?.(run);
        this.pump();
        return run;
    }

    private pump(): void {
        while (!this.stopped && this.running.size < this.maxConcurrency && this.queue.length > 0) {
            const pending = this.queue.shift()!;
            void this.execute(pending);
        }
    }

    private async execute({ run, task }: Pending): Promise<void> {
        const { repos } = this.options;
        const controller = new AbortController();
        const startedAt = this.now().toISOString();
        const started = repos.tasks.updateRun(run.id, { status: 'running', startedAt })!;
        this.running.set(run.id, { controller, run: started });
        this.options.onRunChanged?.(started);
        const timeout = setTimeout(
            () => controller.abort(new ExecutorError('timeout', true)),
            task.policy.maxRuntimeMinutes * 60_000,
        );
        timeout.unref?.();
        try {
            const executor = this.options.executors[task.action.kind === 'system' ? task.action.key : task.action.kind];
            if (!executor) throw new ExecutorError('config_error');
            const result = await Promise.race([
                executor({ task, run: started, signal: controller.signal }),
                new Promise<never>((_, reject) =>
                    controller.signal.addEventListener('abort', () =>
                        reject(
                            controller.signal.reason instanceof ExecutorError
                                ? controller.signal.reason
                                : new ExecutorError('cancelled'),
                        ),
                    ),
                ),
            ]);
            if (result === 'postponed') this.postpone(task, started);
            else {
                this.postponed.delete(started.id);
                this.finish(started, 'succeeded', null);
            }
        } catch (error) {
            // 被中止(取消或超时)时,不管动作抛出了什么,都按中止的原因记录
            const cause: unknown = controller.signal.aborted
                ? controller.signal.reason instanceof ExecutorError
                    ? controller.signal.reason
                    : new ExecutorError('cancelled')
                : error;
            const code: TaskErrorCode = cause instanceof ExecutorError ? cause.code : 'internal';
            const retryable = cause instanceof ExecutorError ? cause.retryable : false;
            if (!(cause instanceof ExecutorError)) this.options.onError(cause);
            if (code === 'cancelled') this.finish(started, 'cancelled', 'cancelled');
            else if (retryable && started.attempt < task.policy.maxAttempts) this.retry(task, started);
            else this.finish(started, 'failed', code);
        } finally {
            clearTimeout(timeout);
            this.running.delete(run.id);
            this.pump();
        }
    }

    /** 系统忙:稍后再试,不消耗重试次数;最多推迟 postponeMax 次。 */
    private postpone(task: TaskRecord, run: TaskRunRecord): void {
        const count = (this.postponed.get(run.id) ?? 0) + 1;
        if (count > this.postponeMax) {
            this.postponed.delete(run.id);
            this.finish(run, 'failed', 'postponed');
            return;
        }
        this.postponed.set(run.id, count);
        this.requeueLater(task, run, this.postponeMs, 'postponed');
    }

    private retry(task: TaskRecord, run: TaskRunRecord): void {
        this.requeueLater(task, run, retryDelayMs(run.attempt), 'timeout', run.attempt + 1);
    }

    private requeueLater(
        task: TaskRecord,
        run: TaskRunRecord,
        delayMs: number,
        why: TaskErrorCode,
        attempt = run.attempt,
    ): void {
        const waiting = this.options.repos.tasks.updateRun(run.id, { status: 'queued', errorCode: why, attempt })!;
        this.options.onRunChanged?.(waiting);
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (this.stopped) return;
            const fresh = this.options.repos.tasks.getById(task.id);
            if (!fresh || !fresh.enabled) {
                this.finish(waiting, 'cancelled', 'cancelled');
                return;
            }
            this.queue.push({ run: waiting, task: fresh });
            this.pump();
        }, delayMs);
        timer.unref?.();
        this.timers.add(timer);
    }

    private finish(run: TaskRunRecord, status: TaskRunRecord['status'], errorCode: TaskErrorCode | null): void {
        const { repos } = this.options;
        const done = repos.tasks.updateRun(run.id, { status, errorCode, finishedAt: this.now().toISOString() });
        if (done) this.options.onRunChanged?.(done);
        repos.tasks.pruneRuns(run.taskId, this.keepRuns);
    }
}
