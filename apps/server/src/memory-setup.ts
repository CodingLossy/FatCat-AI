// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 组装记忆的写入、检索、digest 与每轮上下文(组合根;ADR 0007 第 5.6 节)。
import {
    createDigestBuilder,
    createMemoryContext,
    createMemoryService,
    createRetriever,
    type DigestBuilder,
    type MemoryService,
    type Retriever,
} from '@fatcat-ai/memory';
import type { Repositories } from '@fatcat-ai/storage';
import type { EmbeddingService } from './embeddings.js';

export interface MemoryStack {
    memory: MemoryService;
    retriever: Retriever;
    digest: DigestBuilder;
    context: ReturnType<typeof createMemoryContext>;
    /** 记忆被编辑或删除后调用:重嵌(编辑时)并防抖重建 digest。 */
    changed(ownerId: string, edited?: { id: string; text: string }): void;
    stop(): void;
}

export function createMemoryStack(
    repos: Repositories,
    embeddings: Pick<EmbeddingService, 'enqueue' | 'search'>,
    options: { onError?: (error: unknown, ownerId: string) => void; digestDebounceMs?: number } = {},
): MemoryStack {
    const digest = createDigestBuilder({
        repos,
        ...(options.onError ? { onError: options.onError } : {}),
        ...(options.digestDebounceMs !== undefined ? { debounceMs: options.digestDebounceMs } : {}),
    });
    const memory = createMemoryService(repos, {
        // 新记忆排队嵌入(记忆的向量在统一表中,chunk = 0,ADR 0007 第 5.2 节);没有 embed 配置档时队列不会被处理
        onCreated: (ownerId, id, text) => embeddings.enqueue(ownerId, id, 0, text),
        onChanged: (ownerId) => digest.schedule(ownerId),
    });
    const retriever = createRetriever({
        repos,
        vectors: async (ownerId, query, k, signal) => await embeddings.search(ownerId, query, k, signal),
        // 归档时删掉了向量;被访问回到 active 后重新嵌入
        onReactivated: (ownerId, id, text) => embeddings.enqueue(ownerId, id, 0, text),
    });
    return {
        memory,
        retriever,
        digest,
        context: createMemoryContext({ repos, retriever, digest }),
        changed(ownerId, edited) {
            if (edited) embeddings.enqueue(ownerId, edited.id, 0, edited.text);
            digest.schedule(ownerId);
        },
        stop() {
            retriever.flush();
            digest.stop();
        },
    };
}
