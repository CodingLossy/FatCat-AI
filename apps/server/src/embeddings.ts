// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 嵌入队列 worker(ADR 0014):并发 1、批量、失败退避重试、每日上限。嵌入是网络请求,不占 CPU,
// 所以在主线程中异步运行,不用 worker_threads。没有 embed 配置档时不加载 sqlite-vec,也不运行。
import type { EmbeddingStatus } from '@ai-personal/shared';
import { type ModelProvider, ProviderError } from '@ai-personal/providers';
import type { ModelProfileRecord, Repositories, VectorMatch } from '@ai-personal/storage';

export const DEFAULT_EMBED_BATCH = 32;
/** 每个 owner 每天(UTC)最多嵌入的文本条数。 */
export const DEFAULT_DAILY_EMBED_LIMIT = 5000;

export interface EmbeddingServiceOptions {
    repos: Repositories;
    providerFor: (profile: ModelProfileRecord) => ModelProvider;
    redact?: (text: string) => string;
    now?: () => Date;
    batchSize?: number;
    dailyLimit?: number;
    onError?: (error: unknown) => void;
}

/** 第一个声明了 embed 用途的 OpenAI 兼容配置档(Gemini 推迟,Anthropic 没有嵌入接口)。 */
export function selectEmbedProfile(profiles: readonly ModelProfileRecord[]): ModelProfileRecord | null {
    return profiles.find((p) => p.purpose.includes('embed') && p.kind === 'openai-compatible') ?? null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export function createEmbeddingService(options: EmbeddingServiceOptions) {
    const { repos } = options;
    const store = repos.embeddings;
    const now = options.now ?? (() => new Date());
    const redact = options.redact ?? ((text: string) => text);
    const batchSize = options.batchSize ?? DEFAULT_EMBED_BATCH;
    const dailyLimit = options.dailyLimit ?? DEFAULT_DAILY_EMBED_LIMIT;
    /** 当前的排空过程;同一时刻只有一个(并发 1)。 */
    let running: Promise<void> | null = null;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    /** 上一次嵌入返回的维度与向量表不一致(模型名没变但维度变了,例如改了 dimensions 参数)。 */
    let dimensionMismatch = false;

    const profileFor = (ownerId: string) => selectEmbedProfile(repos.modelProfiles.list(ownerId));

    /** 配置档的模型与现有向量表不一致(维度要等第一次嵌入才知道,在 drain 中检查)。 */
    function mismatch(profile: ModelProfileRecord): boolean {
        const state = store.state();
        return state !== null && store.vectorTableExists() && (dimensionMismatch || state.model !== profile.model);
    }

    function schedule(at: Date | null): void {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!at || stopped) return;
        timer = setTimeout(() => service.kick(), Math.max(0, at.getTime() - now().getTime()));
        timer.unref();
    }

    async function drainOnce(): Promise<void> {
        for (;;) {
            if (stopped) return;
            const jobs = store.due(batchSize);
            if (jobs.length === 0) return schedule(store.nextAttemptAt());
            const ownerId = jobs[0]!.ownerId;
            const batch = jobs.filter((j) => j.ownerId === ownerId);
            const profile = profileFor(ownerId);
            if (!profile || mismatch(profile)) return;
            const used = store.usage(ownerId, day(now()));
            if (used >= dailyLimit) {
                // 到达每日上限:明天(UTC 0 点)再继续
                const tomorrow = new Date(`${day(now())}T00:00:00.000Z`);
                tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
                return schedule(tomorrow);
            }
            const slice = batch.slice(0, dailyLimit - used);
            const provider = options.providerFor(profile);
            if (!provider.embed) return;
            store.loadExtension();
            try {
                const result = await provider.embed(slice.map((j) => j.text));
                const dimensions = result.vectors[0]!.length;
                if (!store.ensureVectorTable({ profileId: profile.id, model: profile.model, dimensions })) {
                    dimensionMismatch = true; // 维度变了:等用户手动重建,不消耗队列
                    return;
                }
                store.complete(slice, result.vectors, profile.model);
                store.addUsage(ownerId, day(now()), slice.length);
            } catch (error) {
                options.onError?.(error);
                const message = error instanceof Error ? redact(error.message) : 'embedding failed';
                store.fail(slice, message);
                // 密钥错误重试也没用:等用户改配置档后再触发
                if (error instanceof ProviderError && error.code === 'auth_failed') return;
            }
        }
    }

    const service = {
        /** 启动时:有 embed 配置档或已有向量表时加载扩展,并开始处理积压的队列。 */
        start(ownerIds: readonly string[]): void {
            if (store.vectorTableExists() || ownerIds.some((id) => profileFor(id))) store.loadExtension();
            service.kick();
        },

        /** 触发一次排空;已经在运行时,结束后再跑一轮。 */
        kick(): void {
            if (stopped) return;
            if (running) {
                again = true;
                return;
            }
            running = (async () => {
                do {
                    again = false;
                    await drainOnce();
                } while (again && !stopped);
            })()
                .catch((error: unknown) => options.onError?.(error))
                .finally(() => {
                    running = null;
                });
        },

        /** 等待当前的排空结束(测试与关闭用)。 */
        async idle(): Promise<void> {
            while (running) await running;
        },

        stop(): void {
            stopped = true;
            schedule(null);
        },

        /** 把一段文本放进队列;没有 embed 配置档时也入队,配置后再处理。 */
        enqueue(ownerId: string, itemId: string, chunk: number, text: string): void {
            if (store.enqueue(ownerId, itemId, chunk, text)) service.kick();
        },

        status(ownerId: string): EmbeddingStatus {
            const profile = profileFor(ownerId);
            const state = store.vectorTableExists() ? store.state() : null;
            const counts = store.counts(ownerId);
            return {
                state: !profile ? 'disabled' : mismatch(profile) ? 'rebuild-required' : 'ready',
                profileId: profile?.id ?? null,
                model: profile?.model ?? null,
                indexModel: state?.model ?? null,
                dimensions: state?.dimensions ?? null,
                ...counts,
                today: store.usage(ownerId, day(now())),
                dailyLimit,
                lastError: store.lastError(ownerId),
            };
        },

        /** 手动重建:删除向量表,全部原文重新入队,按当前配置档的维度重新嵌入。 */
        rebuild(): number {
            const requeued = store.rebuild();
            dimensionMismatch = false;
            service.kick();
            return requeued;
        },

        /** 语义检索(知识库与记忆检索用,PR 9 / 12);向量不可用时返回 null,调用方退回 FTS。 */
        async search(ownerId: string, query: string, k: number, signal?: AbortSignal): Promise<VectorMatch[] | null> {
            const profile = profileFor(ownerId);
            const state = store.state();
            if (!profile || !state || !store.vectorTableExists() || mismatch(profile)) return null;
            const provider = options.providerFor(profile);
            if (!provider.embed) return null;
            const result = await provider.embed([query], signal);
            if (result.vectors[0]!.length !== state.dimensions) return null;
            return store.search(ownerId, result.vectors[0]!, k);
        },
    };
    return service;
}

export type EmbeddingService = ReturnType<typeof createEmbeddingService>;
