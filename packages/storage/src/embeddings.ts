// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 嵌入队列与向量表(ADR 0014)。sqlite-vec 扩展只在需要时加载:配置了 embed 配置档,或者向量表已经存在
// (向量表存在时必须加载,否则 embeddings 上的清理触发器无法执行,items 的级联删除会失败)。
import { load as loadSqliteVec } from 'sqlite-vec';
import type { Connection } from './db.js';

/** 动态创建的向量表与清理触发器的名字。 */
export const VECTOR_TABLE = 'embedding_vec';
const CLEANUP_TRIGGER = 'trg_embedding_vec_cleanup';

/** 失败后的重试:1 分钟起每次翻倍,最多 1 小时;超过次数后停在队列里等重建或重新入队。 */
export const MAX_EMBED_ATTEMPTS = 5;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;
/** 放弃重试的任务的 next_attempt_at,排在所有正常任务之后。 */
const NEVER = '9999-12-31T00:00:00.000Z';

export interface EmbedJob {
    id: number;
    ownerId: string;
    itemId: string;
    chunk: number;
    text: string;
    attempts: number;
}

export interface EmbedState {
    profileId: string | null;
    model: string;
    dimensions: number;
}

export interface VectorMatch {
    itemId: string;
    chunk: number;
    text: string;
    /** sqlite-vec 的 L2 距离,越小越近。 */
    distance: number;
}

export interface EmbedCounts {
    queued: number;
    failed: number;
    embedded: number;
}

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

export function createEmbeddingStore(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    let loaded = false;
    const iso = () => now().toISOString();

    const q = {
        tableExists: sqlite.prepare<[string], { n: number }>(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
        ),
        state: sqlite.prepare<[], { profileId: string | null; model: string; dimensions: number }>(
            'SELECT profile_id AS profileId, model, dimensions FROM embed_state WHERE id = 1',
        ),
        setState: sqlite.prepare(
            `INSERT INTO embed_state (id, profile_id, model, dimensions, created_at)
             VALUES (1, @profileId, @model, @dimensions, @at)
             ON CONFLICT (id) DO UPDATE SET profile_id = excluded.profile_id, model = excluded.model,
               dimensions = excluded.dimensions, created_at = excluded.created_at`,
        ),
        existing: sqlite.prepare<[string, number], { text: string }>(
            'SELECT text FROM embeddings WHERE item_id = ? AND chunk = ?',
        ),
        deleteEmbedding: sqlite.prepare<[string, number]>('DELETE FROM embeddings WHERE item_id = ? AND chunk = ?'),
        enqueue: sqlite.prepare(
            `INSERT INTO embed_queue (owner_id, item_id, chunk, text, attempts, next_attempt_at, created_at)
             VALUES (@ownerId, @itemId, @chunk, @text, 0, @at, @at)
             ON CONFLICT (item_id, chunk) DO UPDATE SET text = excluded.text, attempts = 0,
               next_attempt_at = excluded.next_attempt_at, last_error = NULL`,
        ),
        due: sqlite.prepare<[string, number], EmbedJob>(
            `SELECT id, owner_id AS ownerId, item_id AS itemId, chunk, text, attempts FROM embed_queue
             WHERE next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?`,
        ),
        nextDue: sqlite.prepare<[string], { at: string }>(
            'SELECT min(next_attempt_at) AS at FROM embed_queue WHERE next_attempt_at < ?',
        ),
        dequeue: sqlite.prepare<[number]>('DELETE FROM embed_queue WHERE id = ?'),
        insertEmbedding: sqlite.prepare<[string, string, number, string, string, string], { id: number }>(
            `INSERT INTO embeddings (owner_id, item_id, chunk, text, model, created_at) VALUES (?, ?, ?, ?, ?, ?)
             RETURNING id`,
        ),
        fail: sqlite.prepare<[number, string, string, number]>(
            'UPDATE embed_queue SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?',
        ),
        counts: sqlite.prepare<[{ owner: string; never: string }], EmbedCounts>(
            `SELECT (SELECT count(*) FROM embed_queue WHERE owner_id = @owner AND next_attempt_at < @never) AS queued,
                    (SELECT count(*) FROM embed_queue WHERE owner_id = @owner AND next_attempt_at >= @never) AS failed,
                    (SELECT count(*) FROM embeddings WHERE owner_id = @owner) AS embedded`,
        ),
        lastError: sqlite.prepare<[string], { error: string }>(
            `SELECT last_error AS error FROM embed_queue WHERE owner_id = ? AND last_error IS NOT NULL
             ORDER BY next_attempt_at DESC, id DESC LIMIT 1`,
        ),
        usage: sqlite.prepare<[string, string], { count: number }>(
            'SELECT count FROM embed_usage WHERE owner_id = ? AND day = ?',
        ),
        addUsage: sqlite.prepare<[string, string, number]>(
            `INSERT INTO embed_usage (owner_id, day, count) VALUES (?, ?, ?)
             ON CONFLICT (owner_id, day) DO UPDATE SET count = count + excluded.count`,
        ),
        requeueAll: sqlite.prepare<[{ at: string }]>(
            `INSERT INTO embed_queue (owner_id, item_id, chunk, text, attempts, next_attempt_at, created_at)
             SELECT owner_id, item_id, chunk, text, 0, @at, @at FROM embeddings WHERE true
             ON CONFLICT (item_id, chunk) DO NOTHING`,
        ),
        resetFailed: sqlite.prepare<[string, string]>(
            'UPDATE embed_queue SET attempts = 0, next_attempt_at = ?, last_error = NULL WHERE next_attempt_at >= ?',
        ),
        clearEmbeddings: sqlite.prepare('DELETE FROM embeddings'),
        removeEmbeddings: sqlite.prepare<[string, number]>('DELETE FROM embeddings WHERE item_id = ? AND chunk >= ?'),
        removeQueued: sqlite.prepare<[string, number]>('DELETE FROM embed_queue WHERE item_id = ? AND chunk >= ?'),
        clearState: sqlite.prepare('DELETE FROM embed_state'),
    };

    const store = {
        /** 加载 sqlite-vec(幂等)。 */
        loadExtension(): void {
            if (loaded) return;
            loadSqliteVec(sqlite);
            loaded = true;
        },
        get extensionLoaded(): boolean {
            return loaded;
        },
        vectorTableExists(): boolean {
            return (q.tableExists.get(VECTOR_TABLE)?.n ?? 0) > 0;
        },
        state(): EmbedState | null {
            return q.state.get() ?? null;
        },

        /**
         * 第一次嵌入时按维度建表;已经存在时检查模型与维度是否一致。
         * 返回 false 表示不一致,需要用户手动重建(ADR 0014 第 3 节),此时不做任何修改。
         */
        ensureVectorTable(state: EmbedState): boolean {
            const current = store.state();
            if (current && store.vectorTableExists()) {
                return current.model === state.model && current.dimensions === state.dimensions;
            }
            if (!Number.isInteger(state.dimensions) || state.dimensions < 1 || state.dimensions > 8192) {
                throw new RangeError(`invalid embedding dimensions: ${state.dimensions}`);
            }
            store.loadExtension();
            sqlite.transaction(() => {
                sqlite.exec(`CREATE VIRTUAL TABLE ${VECTOR_TABLE} USING vec0(embedding float[${state.dimensions}])`);
                sqlite.exec(
                    `CREATE TRIGGER ${CLEANUP_TRIGGER} AFTER DELETE ON embeddings BEGIN
                       DELETE FROM ${VECTOR_TABLE} WHERE rowid = OLD.id;
                     END`,
                );
                q.setState.run({ ...state, at: iso() });
            })();
            return true;
        },

        /**
         * 手动重建:删掉向量表与触发器,已有的嵌入连同原文重新入队,失败的任务重置。
         * 新表在下一次嵌入时按新的维度创建。
         */
        rebuild(): number {
            if (store.vectorTableExists()) store.loadExtension();
            return sqlite.transaction(() => {
                const at = iso();
                const requeued = q.requeueAll.run({ at }).changes;
                sqlite.exec(`DROP TRIGGER IF EXISTS ${CLEANUP_TRIGGER}`);
                q.clearEmbeddings.run();
                sqlite.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
                q.clearState.run();
                q.resetFailed.run(at, NEVER);
                return requeued;
            })();
        },

        /** 入队;同一条目同一分块的原文没变时什么都不做,变了就删除旧向量。 */
        enqueue(ownerId: string, itemId: string, chunk: number, text: string): boolean {
            return sqlite.transaction(() => {
                const existing = q.existing.get(itemId, chunk);
                if (existing?.text === text) return false;
                if (existing) q.deleteEmbedding.run(itemId, chunk);
                q.enqueue.run({ ownerId, itemId, chunk, text, at: iso() });
                return true;
            })();
        },

        /** 删除一个条目从 fromChunk 起的向量与排队任务(文件删除或分块变少时;向量行由触发器清理)。 */
        removeItem(itemId: string, fromChunk = 0): void {
            sqlite.transaction(() => {
                q.removeEmbeddings.run(itemId, fromChunk);
                q.removeQueued.run(itemId, fromChunk);
            })();
        },

        /** 到期的任务(按时间先后)。 */
        due(limit: number): EmbedJob[] {
            return q.due.all(iso(), limit);
        },

        /** 下一个待重试任务的时间;没有时为 null(放弃的任务不算)。 */
        nextAttemptAt(): Date | null {
            const at = q.nextDue.get(NEVER)?.at;
            return at ? new Date(at) : null;
        },

        /** 保存一批向量并出队;调用前必须已经 ensureVectorTable。 */
        complete(jobs: readonly EmbedJob[], vectors: readonly Float32Array[], model: string): void {
            const insertVector = sqlite.prepare<[bigint, Buffer]>(
                `INSERT INTO ${VECTOR_TABLE} (rowid, embedding) VALUES (?, ?)`,
            );
            sqlite.transaction(() => {
                const at = iso();
                for (const [i, job] of jobs.entries()) {
                    q.deleteEmbedding.run(job.itemId, job.chunk);
                    const row = q.insertEmbedding.get(job.ownerId, job.itemId, job.chunk, job.text, model, at)!;
                    insertVector.run(BigInt(row.id), toBlob(vectors[i]!));
                    q.dequeue.run(job.id);
                }
            })();
        },

        /** 一批任务失败:按次数退避,超过上限后不再自动重试。 */
        fail(jobs: readonly EmbedJob[], error: string): void {
            sqlite.transaction(() => {
                for (const job of jobs) {
                    const attempts = job.attempts + 1;
                    const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
                    const next =
                        attempts >= MAX_EMBED_ATTEMPTS ? NEVER : new Date(now().getTime() + delay).toISOString();
                    q.fail.run(attempts, next, error.slice(0, 500), job.id);
                }
            })();
        },

        /** KNN 检索:多取一些再按 owner 与软删除过滤。 */
        search(ownerId: string, vector: Float32Array, k: number): VectorMatch[] {
            if (!store.vectorTableExists()) return [];
            store.loadExtension();
            return sqlite
                .prepare<[Buffer, number, string, number], VectorMatch>(
                    `WITH knn AS (
                       SELECT rowid, distance FROM ${VECTOR_TABLE} WHERE embedding MATCH ? AND k = ?
                     )
                     SELECT e.item_id AS itemId, e.chunk, e.text, knn.distance
                     FROM knn JOIN embeddings e ON e.id = knn.rowid JOIN items i ON i.id = e.item_id
                     WHERE e.owner_id = ? AND i.deleted_at IS NULL
                     ORDER BY knn.distance LIMIT ?`,
                )
                .all(toBlob(vector), Math.min(k * 4, 4096), ownerId, k);
        },

        counts(ownerId: string): EmbedCounts {
            return q.counts.get({ owner: ownerId, never: NEVER })!;
        },
        lastError(ownerId: string): string | null {
            return q.lastError.get(ownerId)?.error ?? null;
        },
        usage(ownerId: string, day: string): number {
            return q.usage.get(ownerId, day)?.count ?? 0;
        },
        addUsage(ownerId: string, day: string, n: number): void {
            q.addUsage.run(ownerId, day, n);
        },
    };
    // 向量表已经存在(以前配置过 embed 配置档)时必须加载扩展,否则清理触发器会让 items 的删除失败
    if (store.vectorTableExists()) store.loadExtension();
    return store;
}

export type EmbeddingStore = ReturnType<typeof createEmbeddingStore>;
