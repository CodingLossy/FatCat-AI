// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 记忆维护任务(《记忆模块补充设计》第 5 节;ADR 0007 第 5.7 节):decay → tier → expire,每天一次。
// 单线程分批执行:每批 500 行一个事务,批之间让出事件循环;有对话进行中或 RSS 超过上限时推迟。
// 状态存进 jobs_state(当天的游标与是否完成),中断后从游标继续,同一天重复运行不会重复处理。
// 不调用模型、不启动额外服务。sleep(整理)推迟到 M6,hygiene / optimize 推迟(M2 方案第 7 节)。
import type { MaintenanceRow, Repositories } from '@ai-personal/storage';
import { isProfileKey } from './entity-keys.js';

const DAY_MS = 86_400_000;

/** 半衰期(天):episodic 30、procedural 180、semantic 365,done 的决策 90。 */
export const HALF_LIFE_DAYS = { episodic: 30, procedural: 180, semantic: 365, doneDecision: 90 } as const;
/** 分层阈值:active → cold:衰减 < 0.3 且 60 天未访问;cold → archive:< 0.1 且 180 天未访问。 */
export const TIER_RULES = {
    cold: { below: 0.3, idleDays: 60 },
    archive: { below: 0.1, idleDays: 180 },
} as const;

export const MAINTENANCE_JOBS = ['memory.decay', 'memory.tier', 'memory.expire'] as const;
export type MaintenanceJob = (typeof MAINTENANCE_JOBS)[number];

export const DEFAULT_BATCH_SIZE = 500;
/** RSS 超过这个值时推迟(补充设计第 5 节)。 */
export const DEFAULT_RSS_LIMIT_BYTES = 300 * 1024 * 1024;

const time = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);
/** 最近一次被确认或访问的时间;都没有时取 updated_at。 */
function lastTouched(row: MaintenanceRow): number {
    const t = Math.max(time(row.lastConfirmedAt) || 0, time(row.lastAccessedAt) || 0);
    return t > 0 ? t : time(row.updatedAt);
}
/** 最近一次被访问的时间(没有访问记录时退回确认时间与 updated_at)。 */
function lastAccessed(row: MaintenanceRow): number {
    return time(row.lastAccessedAt) || time(row.lastConfirmedAt) || time(row.updatedAt);
}

/** 置顶与画像类单值事实不衰减。 */
export function neverDecays(row: MaintenanceRow): boolean {
    return row.pinned === 1 || (row.cardinality === 'single' && isProfileKey(row.entityKey));
}

export function halfLifeDays(row: MaintenanceRow): number {
    if (row.subtype === 'decision' && row.decisionState === 'done') return HALF_LIFE_DAYS.doneDecision;
    return HALF_LIFE_DAYS[row.memType];
}

/** decay_score = 0.5^(Δt / half_life),Δt 取最近一次确认或访问至今(天)。 */
export function decayScore(row: MaintenanceRow, now: Date): number {
    if (neverDecays(row)) return 1;
    const days = Math.max(0, (now.getTime() - lastTouched(row)) / DAY_MS);
    return Number(Math.pow(0.5, days / halfLifeDays(row)).toFixed(6));
}

/** 按衰减分数与闲置天数算出的分层;只会往下走(回到 active 由访问与反馈触发)。 */
export function nextTier(row: MaintenanceRow, now: Date): MaintenanceRow['tier'] {
    if (neverDecays(row)) return row.tier;
    const idle = (now.getTime() - lastAccessed(row)) / DAY_MS;
    if (row.decayScore < TIER_RULES.archive.below && idle >= TIER_RULES.archive.idleDays) return 'archive';
    if (row.tier === 'active' && row.decayScore < TIER_RULES.cold.below && idle >= TIER_RULES.cold.idleDays)
        return 'cold';
    return row.tier;
}

export interface MaintenanceOptions {
    repos: Repositories;
    /** 进入 archive 时删除向量行(保留 FTS)。 */
    removeVectors: (itemId: string) => void;
    /** 有对话正在进行时返回 true:任务推迟。 */
    isBusy?: () => boolean;
    rssLimitBytes?: number;
    batchSize?: number;
    now?: () => Date;
    /** 测试中替换 process.memoryUsage().rss。 */
    rss?: () => number;
    /** 有记忆的分层或状态变化后调用(重建 digest)。 */
    onChanged?: (ownerId: string) => void;
}

export type JobOutcome = 'done' | 'already_done' | 'postponed';

interface DailyState {
    day?: string;
    cursor?: string;
    done?: boolean;
    batches?: number;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createMaintenanceRunner(options: MaintenanceOptions) {
    const { repos } = options;
    const store = repos.memoryMaintenance;
    const now = options.now ?? (() => new Date());
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const rssLimit = options.rssLimitBytes ?? DEFAULT_RSS_LIMIT_BYTES;
    const rss = options.rss ?? (() => process.memoryUsage().rss);
    const shouldPause = () => (options.isBusy?.() ?? false) || rss() > rssLimit;

    /** 一批的处理;返回这一批读到的最后一个 id,没有更多时返回 null。 */
    function step(job: MaintenanceJob, ownerId: string, cursor: string, at: Date): string | null {
        if (job === 'memory.expire') {
            const changed = store.expire(ownerId, at.toISOString(), batchSize);
            return changed === batchSize ? cursor : null; // 没有游标:每批都从头取仍然满足条件的
        }
        const rows = store.batch(ownerId, cursor, batchSize);
        if (rows.length === 0) return null;
        if (job === 'memory.decay') {
            const decay: [string, number][] = [];
            for (const row of rows) {
                const score = decayScore(row, at);
                if (Math.abs(score - row.decayScore) > 1e-6) decay.push([row.id, score]);
            }
            store.apply({ decay });
        } else {
            const tier: [string, MaintenanceRow['tier']][] = [];
            for (const row of rows) {
                const next = nextTier(row, at);
                if (next !== row.tier) tier.push([row.id, next]);
            }
            store.apply({ tier });
            for (const [id, next] of tier) if (next === 'archive') options.removeVectors(id);
        }
        return rows.length < batchSize ? null : rows.at(-1)!.id;
    }

    async function run(job: MaintenanceJob, ownerId: string): Promise<JobOutcome> {
        const at = now();
        const day = at.toISOString().slice(0, 10);
        const saved = store.jobState(ownerId, job);
        const prior = (saved?.state ?? {}) as DailyState;
        if (prior.day === day && prior.done) return 'already_done';
        const state: DailyState = prior.day === day ? { ...prior } : { day, cursor: '', batches: 0 };
        const save = (done: boolean) =>
            store.putJobState(ownerId, job, {
                lastRunAt: done ? at.toISOString() : (saved?.lastRunAt ?? null),
                nextRunAt: null,
                state: { ...state, done },
            });
        for (;;) {
            if (shouldPause()) {
                save(false);
                return 'postponed';
            }
            const next = step(job, ownerId, state.cursor ?? '', at);
            state.batches = (state.batches ?? 0) + 1;
            if (next === null) break;
            state.cursor = next;
            save(false);
            await yieldToEventLoop();
        }
        save(true);
        return 'done';
    }

    return {
        /** 运行一个任务(幂等:同一天已完成时直接返回 already_done)。 */
        run,
        /** 按顺序运行全部任务;任一任务推迟时停下,之后再调用会从游标继续。 */
        async runAll(ownerId: string): Promise<Record<MaintenanceJob, JobOutcome | 'skipped'>> {
            const result = {
                'memory.decay': 'skipped',
                'memory.tier': 'skipped',
                'memory.expire': 'skipped',
            } as Record<MaintenanceJob, JobOutcome | 'skipped'>;
            let changed = false;
            for (const job of MAINTENANCE_JOBS) {
                result[job] = await run(job, ownerId);
                if (result[job] === 'done') changed = true;
                if (result[job] === 'postponed') break;
            }
            if (changed) options.onChanged?.(ownerId);
            return result;
        },
    };
}

export type MaintenanceRunner = ReturnType<typeof createMaintenanceRunner>;
