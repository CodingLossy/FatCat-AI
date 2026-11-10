// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 按授权目录选择是否进入知识库(ADR 0015 第 6 节,M2 PR 15):只用 ADD COLUMN。
 * 默认不进入:已有的目录在用户勾选之前不会被索引,已有的分块在下一次索引时清理。已发布的迁移不得修改。
 */
export const migration0008: Migration = {
    id: 8,
    name: 'kb_roots',
    sql: /* sql */ `
ALTER TABLE fs_roots ADD COLUMN kb_enabled INTEGER NOT NULL DEFAULT 0 CHECK (kb_enabled IN (0,1));
`,
};
