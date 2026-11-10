// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 本地知识库的分块与全文检索(ADR 0015)。向量在 embeddings.ts 中,以 (item_id, chunk) 对应。
import type { Connection } from './db.js';

export interface KbChunkInput {
    page: number | null;
    heading: string | null;
    text: string;
}

export interface KbChunk extends KbChunkInput {
    itemId: string;
    chunk: number;
    /** 文件条目的标题(文件名)与 meta.path。 */
    title: string;
    path: string | null;
}

export interface KbFile {
    itemId: string;
    path: string;
    mtime: string | null;
    size: number | null;
}

export interface KbSource {
    mtime: string | null;
    size: number | null;
    chunkChars: number;
    chunks: number;
    error: string | null;
}

const CHUNK_COLUMNS = `c.item_id AS itemId, c.chunk, c.page, c.heading, c.text, i.title,
    json_extract(i.meta, '$.path') AS path`;

/** trigram 至少需要 3 个字符:每个词作为短语,OR 连接。 */
function ftsMatch(query: string): string | null {
    const words = query.split(/\s+/).filter((w) => [...w].length >= 3);
    return words.length ? words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR ') : null;
}

export function createKbRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const q = {
        files: sqlite.prepare<
            [string],
            { itemId: string; path: string | null; mtime: string | null; size: number | null }
        >(
            `SELECT id AS itemId, json_extract(meta, '$.path') AS path, json_extract(meta, '$.mtime') AS mtime,
                    json_extract(meta, '$.size') AS size
             FROM items WHERE owner_id = ? AND source = 'files' AND type = 'files.file' AND deleted_at IS NULL
             ORDER BY id`,
        ),
        stale: sqlite.prepare<[string], { itemId: string }>(
            `SELECT s.item_id AS itemId FROM kb_sources s JOIN items i ON i.id = s.item_id
             WHERE s.owner_id = ? AND i.deleted_at IS NOT NULL`,
        ),
        source: sqlite.prepare<[string], KbSource>(
            `SELECT mtime, size, chunk_chars AS chunkChars, chunks, error FROM kb_sources WHERE item_id = ?`,
        ),
        upsertSource: sqlite.prepare(
            `INSERT INTO kb_sources (item_id, owner_id, mtime, size, chunk_chars, chunks, error, indexed_at)
             VALUES (@itemId, @ownerId, @mtime, @size, @chunkChars, @chunks, @error, @at)
             ON CONFLICT (item_id) DO UPDATE SET mtime = excluded.mtime, size = excluded.size,
               chunk_chars = excluded.chunk_chars, chunks = excluded.chunks, error = excluded.error,
               indexed_at = excluded.indexed_at`,
        ),
        deleteSource: sqlite.prepare<[string]>('DELETE FROM kb_sources WHERE item_id = ?'),
        deleteChunks: sqlite.prepare<[string]>('DELETE FROM kb_chunks WHERE item_id = ?'),
        insertChunk: sqlite.prepare(
            `INSERT INTO kb_chunks (owner_id, item_id, chunk, page, heading, text)
             VALUES (@ownerId, @itemId, @chunk, @page, @heading, @text)`,
        ),
        chunk: sqlite.prepare<[string, string, number], KbChunk>(
            `SELECT ${CHUNK_COLUMNS} FROM kb_chunks c JOIN items i ON i.id = c.item_id
             WHERE c.owner_id = ? AND c.item_id = ? AND c.chunk = ? AND i.deleted_at IS NULL`,
        ),
        count: sqlite.prepare<[{ owner: string }], { files: number; chunks: number }>(
            `SELECT (SELECT count(*) FROM kb_sources WHERE owner_id = @owner) AS files,
                    (SELECT count(*) FROM kb_chunks WHERE owner_id = @owner) AS chunks`,
        ),
    };

    return {
        /** 当前未删除的文件条目(授权目录内,由 files 提供者登记)。 */
        files(ownerId: string): KbFile[] {
            return q.files.all(ownerId).filter((f): f is KbFile => typeof f.path === 'string');
        },
        /** 已经被软删除、但还有分块的文件条目(文件被删除或授权被撤销)。 */
        staleItems(ownerId: string): string[] {
            return q.stale.all(ownerId).map((r) => r.itemId);
        },
        source(itemId: string): KbSource | null {
            return q.source.get(itemId) ?? null;
        },
        /** 整体替换一个文件的分块(在一个事务中)。 */
        replace(
            ownerId: string,
            file: { itemId: string; mtime: string | null; size: number | null; chunkChars: number },
            chunks: readonly KbChunkInput[],
            error: string | null = null,
        ): void {
            sqlite.transaction(() => {
                q.deleteChunks.run(file.itemId);
                for (const [i, c] of chunks.entries()) {
                    q.insertChunk.run({ ownerId, itemId: file.itemId, chunk: i, ...c });
                }
                q.upsertSource.run({
                    ...file,
                    ownerId,
                    chunks: chunks.length,
                    error,
                    at: now().toISOString(),
                });
            })();
        },
        remove(itemId: string): void {
            sqlite.transaction(() => {
                q.deleteChunks.run(itemId);
                q.deleteSource.run(itemId);
            })();
        },
        get(ownerId: string, itemId: string, chunk: number): KbChunk | null {
            return q.chunk.get(ownerId, itemId, chunk) ?? null;
        },
        /** 全文检索(trigram,bm25 排序);太短的查询回退为 LIKE。 */
        search(ownerId: string, query: string, limit: number): KbChunk[] {
            const match = ftsMatch(query.trim());
            if (match) {
                return sqlite
                    .prepare<[string, string, number], KbChunk>(
                        `SELECT ${CHUNK_COLUMNS} FROM kb_chunks_fts f JOIN kb_chunks c ON c.id = f.rowid
                         JOIN items i ON i.id = c.item_id
                         WHERE kb_chunks_fts MATCH ? AND c.owner_id = ? AND i.deleted_at IS NULL
                         ORDER BY bm25(kb_chunks_fts) LIMIT ?`,
                    )
                    .all(match, ownerId, limit);
            }
            const like = `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            return sqlite
                .prepare<[string, string, number], KbChunk>(
                    `SELECT ${CHUNK_COLUMNS} FROM kb_chunks c JOIN items i ON i.id = c.item_id
                     WHERE c.text LIKE ? ESCAPE '\\' AND c.owner_id = ? AND i.deleted_at IS NULL
                     ORDER BY c.item_id, c.chunk LIMIT ?`,
                )
                .all(like, ownerId, limit);
        },
        counts(ownerId: string): { files: number; chunks: number } {
            return q.count.get({ owner: ownerId })!;
        },
    };
}

export type KbRepository = ReturnType<typeof createKbRepository>;
