// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/** MCP 服务器配置(ADR 0013);不保存环境变量的值。已发布的迁移不得修改。 */
export const migration0004: Migration = {
    id: 4,
    name: 'mcp_servers',
    sql: /* sql */ `
CREATE TABLE mcp_servers (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  command          TEXT NOT NULL,
  args_json        TEXT NOT NULL,
  cwd              TEXT,
  env_names_json   TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  tool_risks_json  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (owner_id, name)
);
`,
};
