// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { FsRoot } from '@ai-personal/shared';
import type { Connection } from './db.js';
import { newId } from './ids.js';

type Row = Omit<FsRoot, 'knowledgeBase'> & { knowledgeBase: number };
const toRoot = (r: Row): FsRoot => ({ ...r, knowledgeBase: r.knowledgeBase === 1 });

/** 授权目录(ADR 0011);路径由调用方规范化(realpath)后传入。kb_enabled 见 ADR 0015 第 6 节。 */
export function createFsRootRepository(conn: Connection, now: () => Date) {
    const { sqlite } = conn;
    const COLUMNS = 'id, path, label, kb_enabled AS knowledgeBase, created_at AS createdAt';
    const q = {
        list: sqlite.prepare<[string], Row>(
            `SELECT ${COLUMNS} FROM fs_roots WHERE owner_id = ? ORDER BY created_at, id`,
        ),
        get: sqlite.prepare<[string, string], Row>(`SELECT ${COLUMNS} FROM fs_roots WHERE owner_id = ? AND id = ?`),
        insert: sqlite.prepare(
            `INSERT INTO fs_roots (id, owner_id, path, label, kb_enabled, created_at)
             VALUES (@id, @ownerId, @path, @label, @kb, @createdAt)`,
        ),
        setKb: sqlite.prepare<[number, string, string]>(
            'UPDATE fs_roots SET kb_enabled = ? WHERE owner_id = ? AND id = ?',
        ),
        delete: sqlite.prepare<[string, string]>('DELETE FROM fs_roots WHERE owner_id = ? AND id = ?'),
    };
    return {
        list(ownerId: string): FsRoot[] {
            return q.list.all(ownerId).map(toRoot);
        },
        get(ownerId: string, id: string): FsRoot | null {
            const row = q.get.get(ownerId, id);
            return row ? toRoot(row) : null;
        },
        create(ownerId: string, input: { path: string; label: string; knowledgeBase?: boolean }): FsRoot {
            const id = newId(now());
            q.insert.run({
                id,
                ownerId,
                path: input.path,
                label: input.label,
                kb: input.knowledgeBase ? 1 : 0,
                createdAt: now().toISOString(),
            });
            return toRoot(q.get.get(ownerId, id)!);
        },
        /** 切换是否进入知识库;返回更新后的目录,不存在时返回 null。 */
        setKnowledgeBase(ownerId: string, id: string, enabled: boolean): FsRoot | null {
            if (q.setKb.run(enabled ? 1 : 0, ownerId, id).changes === 0) return null;
            return toRoot(q.get.get(ownerId, id)!);
        },
        delete(ownerId: string, id: string): boolean {
            return q.delete.run(ownerId, id).changes > 0;
        },
    };
}
