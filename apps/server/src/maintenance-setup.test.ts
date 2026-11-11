// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { localDate } from '@fatcat-ai/shared';
import { Cron } from 'croner';
import { afterEach, describe, expect, it } from 'vitest';
import { MAINTENANCE_CRON, scheduleDaily, startMaintenance, type DailyJob } from './maintenance-setup.js';
import { createTestServer, type TestServer } from './test-helpers.js';

const local = (d: Date, timeZone: string) => d.toLocaleString('sv', { timeZone });
/** 从 from 起,按 timeZone 的 03:30 排出的接下来几次运行(本地时间)。 */
const runs = (timeZone: string, from: string, n = 3) =>
    new Cron(MAINTENANCE_CRON, { timezone: timeZone, paused: true })
        .nextRuns(n, new Date(from))
        .map((d) => local(d, timeZone));

let job: DailyJob | null = null;
let s: TestServer | null = null;
afterEach(async () => {
    job?.stop();
    job = null;
    await s?.cleanup();
    s = null;
});

describe('定时任务按用户时区排期(ADR 0023 第 5 节)', () => {
    it('下一次运行是用户时区的 03:30;改时区后立即按新时区重新排期', () => {
        job = scheduleDaily(() => {}, 'Asia/Shanghai');
        const first = job.nextRun()!;
        expect(local(first, 'Asia/Shanghai').slice(11)).toBe('03:30:00');
        job.reschedule('America/Los_Angeles');
        const next = job.nextRun()!;
        expect(local(next, 'America/Los_Angeles').slice(11)).toBe('03:30:00');
        expect(next.getTime()).not.toBe(first.getTime());
        job.stop();
        expect(job.nextRun()).toBeNull();
    });

    it('夏令时切换日既不漏跑也不重跑', () => {
        // 美国的切换在凌晨 2 点,03:30 照常
        expect(runs('America/Los_Angeles', '2026-03-07T00:00:00Z')).toEqual([
            '2026-03-07 03:30:00',
            '2026-03-08 03:30:00',
            '2026-03-09 03:30:00',
        ]);
        expect(runs('America/Los_Angeles', '2026-10-31T00:00:00Z')).toEqual([
            '2026-10-31 03:30:00',
            '2026-11-01 03:30:00',
            '2026-11-02 03:30:00',
        ]);
        // 查塔姆群岛 02:45 → 03:45:03:30 被跳过的那天在 03:45(第一个有效时刻)运行,不漏跑
        expect(runs('Pacific/Chatham', '2026-09-25T00:00:00Z')).toEqual([
            '2026-09-26 03:30:00',
            '2026-09-27 03:45:00',
            '2026-09-28 03:30:00',
        ]);
        // 03:45 → 02:45:03:30 出现两次的那天只运行一次
        expect(runs('Pacific/Chatham', '2026-04-03T00:00:00Z')).toEqual([
            '2026-04-04 03:30:00',
            '2026-04-05 03:30:00',
            '2026-04-06 03:30:00',
        ]);
    });

    it('维护任务的日期键按用户时区:同一天不跑两次,改时区后换算到新的一天才再跑', async () => {
        s = await createTestServer();
        const { repos } = s;
        const owner = repos.owners.create({ username: 'owner', passwordHash: 'x' });
        repos.settings.update(owner.id, { timeZone: 'UTC' });
        const scheduler = startMaintenance({
            repos,
            removeVectors: () => {},
            isBusy: () => false,
            onChanged: () => {},
            onError: (e) => {
                throw e;
            },
            schedule: false,
            timeZone: 'UTC',
        });
        expect(scheduler.nextRun()).toBeNull();
        const now = new Date();
        expect(await scheduler.runner.run('memory.decay', owner.id)).toBe('done');
        expect(await scheduler.runner.run('memory.decay', owner.id)).toBe('already_done');
        // 换到当地已是另一天的时区(UTC+14 与 UTC-12 总有一个和 UTC 不是同一天):按新的一天再跑一次
        const other =
            localDate(now, 'Pacific/Kiritimati') === localDate(now, 'UTC') ? 'Etc/GMT+12' : 'Pacific/Kiritimati';
        repos.settings.update(owner.id, { timeZone: other });
        expect(await scheduler.runner.run('memory.decay', owner.id)).toBe('done');
        expect(await scheduler.runner.run('memory.decay', owner.id)).toBe('already_done');
        // 换回同一天的时区:日期键已标记完成,不补跑
        repos.settings.update(owner.id, { timeZone: other });
        expect(await scheduler.runner.run('memory.decay', owner.id)).toBe('already_done');
        scheduler.stop();
    });
});
