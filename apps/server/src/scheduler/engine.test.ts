// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { TaskPolicy, TaskTrigger } from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestServer, type TestServer } from '../test-helpers.js';
import { ExecutorError, TaskEngine, type Executor } from './engine.js';

const MIN = 60_000;
const policy = (over: Partial<TaskPolicy> = {}): TaskPolicy => ({
    maxAttempts: 3,
    misfire: 'skip',
    quietHours: null,
    maxRuntimeMinutes: 10,
    ...over,
});

let s: TestServer;
let repos: Repositories;
let ownerId: string;
let engine: TaskEngine | null = null;

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-16T10:00:00Z'));
    s = await createTestServer();
    repos = s.repos;
    ownerId = repos.owners.create({ username: 'owner', passwordHash: 'x' }).id;
});
afterEach(async () => {
    engine?.stop();
    engine = null;
    vi.useRealTimers();
    await s.cleanup();
});

function seed(key: string, trigger: TaskTrigger, p: TaskPolicy) {
    return repos.tasks.ensureSystem(ownerId, { key, name: key, trigger, action: { kind: 'system', key }, policy: p });
}
function make(executors: Record<string, Executor>, extra: Partial<ConstructorParameters<typeof TaskEngine>[0]> = {}) {
    engine = new TaskEngine({
        repos,
        executors,
        timeZone: () => 'UTC',
        onError: (e) => {
            throw e;
        },
        ...extra,
    });
    return engine;
}
const runsOf = (taskId: string) => repos.tasks.listRuns(taskId, { limit: 50 }).items;

describe('任务调度器(ADR 0033)', () => {
    it('cron 到点触发,写运行记录并排下一次;重启后任务仍在', async () => {
        const task = seed('a', { kind: 'cron', expression: '*/5 * * * *' }, policy());
        const calls: string[] = [];
        const e = make({ a: async () => (calls.push('a'), 'succeeded') });
        e.start();
        expect(e.nextRun(task.id)?.toISOString()).toBe('2026-11-16T10:05:00.000Z');
        await vi.advanceTimersByTimeAsync(5 * MIN);
        expect(calls).toEqual(['a']);
        expect(runsOf(task.id)[0]).toMatchObject({ status: 'succeeded', trigger: 'schedule' });
        expect(e.nextRun(task.id)?.toISOString()).toBe('2026-11-16T10:10:00.000Z');
        e.stop();
        // 新引擎(相当于重启)重新读出任务并继续排期
        const e2 = make({ a: async () => 'succeeded' });
        e2.start();
        expect(e2.nextRun(task.id)?.toISOString()).toBe('2026-11-16T10:10:00.000Z');
    });

    it('错过策略:skip 只记一行 missed;catchUp 启动后只补一次,不论错过几次', async () => {
        const skip = seed('skip', { kind: 'cron', expression: '*/5 * * * *' }, policy({ misfire: 'skip' }));
        const catchUp = seed('catch', { kind: 'cron', expression: '*/5 * * * *' }, policy({ misfire: 'catchUp' }));
        for (const t of [skip, catchUp]) repos.tasks.markFired(t.id, '2026-11-16T08:00:00.000Z'); // 错过了 24 次
        const calls: string[] = [];
        const e = make({
            skip: async () => (calls.push('skip'), 'succeeded'),
            catch: async () => (calls.push('catch'), 'succeeded'),
        });
        e.start();
        expect(runsOf(skip.id)).toMatchObject([{ status: 'skipped', errorCode: 'missed' }]);
        expect(runsOf(catchUp.id)).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(10 * MIN);
        const caught = runsOf(catchUp.id).filter((r) => r.trigger === 'catch_up');
        expect(caught).toHaveLength(1);
        expect(runsOf(skip.id).filter((r) => r.errorCode === 'missed')).toHaveLength(1);
    });

    it('超过 24 小时的错过一律当 skip', () => {
        const t = seed('old', { kind: 'cron', expression: '0 3 * * *' }, policy({ misfire: 'catchUp' }));
        repos.tasks.markFired(t.id, '2026-11-10T03:00:00.000Z');
        make({ old: async () => 'succeeded' }).start();
        expect(runsOf(t.id)).toMatchObject([{ status: 'skipped', errorCode: 'missed' }]);
    });

    it('一次性任务:到点运行一次后标为已完成;启动时已过期按错过策略', async () => {
        const once = seed('once', { kind: 'once', at: '2026-11-16T10:30:00.000Z' }, policy());
        const past = seed('past', { kind: 'once', at: '2026-11-16T09:00:00.000Z' }, policy({ misfire: 'catchUp' }));
        const calls: string[] = [];
        const e = make({
            once: async () => (calls.push('once'), 'succeeded'),
            past: async () => (calls.push('past'), 'succeeded'),
        });
        e.start();
        await vi.advanceTimersByTimeAsync(10 * MIN);
        expect(calls).toEqual(['past']);
        await vi.advanceTimersByTimeAsync(20 * MIN);
        expect(calls).toEqual(['past', 'once']);
        expect(repos.tasks.getById(once.id)?.status).toBe('completed');
        expect(repos.tasks.getById(past.id)?.status).toBe('completed');
        await vi.advanceTimersByTimeAsync(60 * MIN);
        expect(calls).toHaveLength(2);
    });

    it('可重试失败按 1/5 分钟重试并共用一条记录;次数用尽记 failed;不可重试的失败不重试', async () => {
        const flaky = seed('flaky', { kind: 'cron', expression: '0 12 * * *' }, policy({ maxAttempts: 3 }));
        const denied = seed('denied', { kind: 'cron', expression: '0 12 * * *' }, policy({ maxAttempts: 3 }));
        const attempts: string[] = [];
        const e = make({
            flaky: async () => {
                attempts.push('flaky');
                throw new ExecutorError('timeout', true);
            },
            denied: async () => {
                attempts.push('denied');
                throw new ExecutorError('approval_rejected');
            },
        });
        e.start();
        e.runNow(flaky.id);
        e.runNow(denied.id);
        await vi.advanceTimersByTimeAsync(0);
        expect(attempts.sort()).toEqual(['denied', 'flaky']);
        await vi.advanceTimersByTimeAsync(1 * MIN);
        expect(attempts.filter((a) => a === 'flaky')).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(5 * MIN);
        expect(attempts.filter((a) => a === 'flaky')).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(15 * MIN);
        expect(attempts.filter((a) => a === 'flaky')).toHaveLength(3);
        expect(attempts.filter((a) => a === 'denied')).toHaveLength(1);
        expect(runsOf(flaky.id)).toMatchObject([{ status: 'failed', errorCode: 'timeout', attempt: 3 }]);
        expect(runsOf(denied.id)).toMatchObject([{ status: 'failed', errorCode: 'approval_rejected', attempt: 1 }]);
    });

    it('系统忙(postponed)10 分钟后再试、不消耗重试次数,超过上限记 failed', async () => {
        const t = seed('busy', { kind: 'cron', expression: '0 12 * * *' }, policy({ maxAttempts: 1 }));
        let busy = true;
        let n = 0;
        const e = make({ busy: async () => (n++, busy ? 'postponed' : 'succeeded') }, { postponeMax: 2 });
        e.start();
        e.runNow(t.id);
        await vi.advanceTimersByTimeAsync(0);
        expect(runsOf(t.id)[0]).toMatchObject({ status: 'queued', errorCode: 'postponed' });
        busy = false;
        await vi.advanceTimersByTimeAsync(10 * MIN);
        expect(n).toBe(2);
        expect(runsOf(t.id)[0]).toMatchObject({ status: 'succeeded', errorCode: null });
        busy = true;
        e.runNow(t.id);
        await vi.advanceTimersByTimeAsync(40 * MIN);
        expect(runsOf(t.id)[0]).toMatchObject({ status: 'failed', errorCode: 'postponed' });
    });

    it('静默时段:skip 记一行;defer 推迟到结束后,多次合并为一次', async () => {
        const quiet = { start: '09:00', end: '11:00' }; // 现在 10:00 在静默内
        const skip = seed(
            'qs',
            { kind: 'cron', expression: '*/10 * * * *' },
            policy({ quietHours: { ...quiet, behavior: 'skip' } }),
        );
        const defer = seed(
            'qd',
            { kind: 'cron', expression: '*/10 * * * *' },
            policy({ quietHours: { ...quiet, behavior: 'defer' } }),
        );
        const calls: string[] = [];
        const e = make({
            qs: async () => (calls.push('qs'), 'succeeded'),
            qd: async () => (calls.push('qd'), 'succeeded'),
        });
        e.start();
        await vi.advanceTimersByTimeAsync(50 * MIN); // 10:50,期间有 5 次触发
        expect(calls).toEqual([]);
        expect(runsOf(skip.id).every((r) => r.status === 'skipped' && r.errorCode === 'quiet_hours')).toBe(true);
        await vi.advanceTimersByTimeAsync(10 * MIN + 1000); // 过了 11:00
        expect(calls.filter((c) => c === 'qd').length).toBe(2); // 11:00 的延后运行 1 次 + 11:00 的正常触发 1 次
        expect(runsOf(defer.id).filter((r) => r.status === 'skipped')).toHaveLength(0);
    });

    it('同一任务不会重叠运行;全局并发有上限,超出的排队', async () => {
        const a = seed('a', { kind: 'cron', expression: '0 12 * * *' }, policy());
        const b = seed('b', { kind: 'cron', expression: '0 12 * * *' }, policy());
        const c = seed('c', { kind: 'cron', expression: '0 12 * * *' }, policy());
        const release: Array<() => void> = [];
        let active = 0;
        let peak = 0;
        const hold: Executor = () =>
            new Promise((resolve) => {
                active++;
                peak = Math.max(peak, active);
                release.push(() => {
                    active--;
                    resolve('succeeded');
                });
            });
        const e = make({ a: hold, b: hold, c: hold }, { maxConcurrency: 2 });
        e.start();
        expect(e.runNow(a.id)).not.toBeNull();
        expect(e.runNow(a.id)).toBeNull(); // 已在排队或运行
        e.runNow(b.id);
        e.runNow(c.id);
        await vi.advanceTimersByTimeAsync(0);
        expect(peak).toBe(2);
        expect(runsOf(c.id)[0]?.status).toBe('queued');
        release.shift()!();
        await vi.advanceTimersByTimeAsync(0);
        expect(runsOf(c.id)[0]?.status).toBe('running');
        for (const r of release.splice(0)) r();
        await vi.advanceTimersByTimeAsync(0);
        expect(peak).toBe(2);
    });

    it('取消排队中与运行中的记录;停止时未结束的记录标为已取消;启动时清理上次遗留', async () => {
        const a = seed('a', { kind: 'cron', expression: '0 12 * * *' }, policy());
        const e = make({
            a: (ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('x')))),
        });
        e.start();
        const run = e.runNow(a.id)!;
        await vi.advanceTimersByTimeAsync(0);
        expect(repos.tasks.getRun(run.id)?.status).toBe('running');
        expect(e.cancel(run.id)).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(repos.tasks.getRun(run.id)).toMatchObject({ status: 'cancelled', errorCode: 'cancelled' });
        expect(e.cancel(run.id)).toBe(false);
        // 模拟崩溃遗留
        const stale = repos.tasks.createRun({
            taskId: a.id,
            trigger: 'schedule',
            scheduledFor: new Date().toISOString(),
            status: 'running',
        });
        e.stop();
        make({ a: async () => 'succeeded' }).start();
        expect(repos.tasks.getRun(stale.id)).toMatchObject({ status: 'cancelled', errorCode: 'internal' });
    });

    it('运行超过最长时间记 timeout 并重试;停用的任务不再触发', async () => {
        const a = seed(
            'slow',
            { kind: 'cron', expression: '*/5 * * * *' },
            policy({ maxAttempts: 1, maxRuntimeMinutes: 1 }),
        );
        const e = make({ slow: () => new Promise(() => {}) });
        e.start();
        e.runNow(a.id);
        await vi.advanceTimersByTimeAsync(1 * MIN + 10);
        expect(runsOf(a.id)[0]).toMatchObject({ status: 'failed', errorCode: 'timeout' });
        repos.tasks.update(ownerId, a.id, { enabled: false });
        e.rescheduleAll();
        expect(e.nextRun(a.id)).toBeNull();
    });
});

describe('事件触发(ADR 0035)', () => {
    it('每小时有上限:超出记 throttled;任务正在运行时的事件被丢弃;停用的任务忽略事件', async () => {
        const t = seed('ev', { kind: 'webhook' }, policy());
        let n = 0;
        const e = make({ ev: async () => (n++, 'succeeded') }, { eventsPerHour: 3 });
        e.start();
        expect(e.nextRun(t.id)).toBeNull(); // 事件触发器没有下一次
        for (let i = 0; i < 3; i++) {
            expect(e.fireEvent(t.id, 'x')).toBe('queued');
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(e.fireEvent(t.id, 'x')).toBe('throttled');
        expect(runsOf(t.id)[0]).toMatchObject({ status: 'skipped', errorCode: 'throttled' });
        expect(n).toBe(3);
        await vi.advanceTimersByTimeAsync(61 * MIN); // 一小时后恢复
        expect(e.fireEvent(t.id)).toBe('queued');
        repos.tasks.update(ownerId, t.id, { enabled: false });
        expect(e.fireEvent(t.id)).toBe('ignored');
    });

    it('任务正在运行时来的事件不再排队(防回环与事件风暴)', async () => {
        const t = seed('slow', { kind: 'webhook' }, policy());
        const release: Array<() => void> = [];
        const e = make({ slow: () => new Promise((resolve) => release.push(() => resolve('succeeded'))) });
        e.start();
        expect(e.fireEvent(t.id)).toBe('queued');
        await vi.advanceTimersByTimeAsync(0);
        expect(e.fireEvent(t.id)).toBe('busy');
        expect(runsOf(t.id)).toHaveLength(1);
        release[0]!();
    });
});
