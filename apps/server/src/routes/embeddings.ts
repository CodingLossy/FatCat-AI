// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 嵌入与向量索引的状态和手动重建(ADR 0014)。
import { createRoute } from '@hono/zod-openapi';
import { EmbeddingRebuildResult, EmbeddingStatus } from '@fatcat-ai/shared';
import type { EmbeddingService } from '../embeddings.js';
import { requireOwner } from '../auth/middleware.js';
import { authErrors, json, router } from './common.js';

const statusRoute = createRoute({
    method: 'get',
    path: '/embeddings/status',
    tags: ['models'],
    summary: 'Embedding profile, vector index and queue status',
    responses: { 200: json(EmbeddingStatus, 'Status'), ...authErrors },
});

const rebuildRoute = createRoute({
    method: 'post',
    path: '/embeddings/rebuild',
    tags: ['models'],
    summary: 'Drop the vector index and re-embed everything with the current embed profile',
    responses: { 200: json(EmbeddingRebuildResult, 'Re-queued'), ...authErrors },
});

export function embeddingRoutes(deps: { embeddings: EmbeddingService }) {
    const { embeddings } = deps;
    return router()
        .openapi(statusRoute, (c) => c.json(embeddings.status(requireOwner(c)), 200))
        .openapi(rebuildRoute, (c) => {
            requireOwner(c);
            const requeued = embeddings.rebuild();
            c.get('logger').info({ requeued }, 'vector index rebuild requested');
            return c.json({ requeued }, 200);
        });
}
