// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 增量同步的变更日志读取(ADR 0045 第 2 节)。写入由数据库触发器完成(迁移 0021),这里只读。
import type { SyncKind } from '@fatcat-ai/shared';
import type { Statement } from 'better-sqlite3';
import type { Connection } from './db.js';

export interface ChangeRow {
    seq: number;
    kind: SyncKind;
    entityId: string;
    sessionId: string | null;
    deleted: boolean;
    changedAt: string;
}

export function createSyncRepository(conn: Connection) {
    const { sqlite } = conn;
    // 延迟准备:迁移 0021 之前的库上也能创建仓储(迁移测试要用旧版本的库)
    let select: Statement<[string, number, string, number], Omit<ChangeRow, 'deleted'> & { deleted: number }> | null =
        null;
    const rows = (ownerId: string, afterSeq: number, filter: string, limit: number) => {
        select ??= sqlite.prepare(
            `SELECT seq, kind, entity_id AS entityId, session_id AS sessionId, deleted, changed_at AS changedAt
             FROM change_log
             WHERE owner_id = ? AND seq > ? AND instr(?, kind) > 0
             ORDER BY seq LIMIT ?`,
        );
        return select.all(ownerId, afterSeq, filter, limit);
    };
    return {
        /** seq 大于 afterSeq 的变化,按 seq 升序;kinds 为空表示全部。 */
        changesAfter(ownerId: string, afterSeq: number, limit: number, kinds: readonly SyncKind[]): ChangeRow[] {
            // kinds 只会是三个固定词,拼成逗号串用 instr 过滤(kind 之间互不是子串)
            const filter = (kinds.length > 0 ? kinds : (['session', 'message', 'item'] as const)).join(',');
            return rows(ownerId, afterSeq, filter, limit).map((r) => ({ ...r, deleted: r.deleted === 1 }));
        },
    };
}

export type SyncRepository = ReturnType<typeof createSyncRepository>;
