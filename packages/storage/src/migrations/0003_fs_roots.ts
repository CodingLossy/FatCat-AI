// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/** 本地文件工具的授权目录(ADR 0011)。已发布的迁移不得修改。 */
export const migration0003: Migration = {
    id: 3,
    name: 'fs_roots',
    sql: /* sql */ `
CREATE TABLE fs_roots (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, path)
);
`,
};
