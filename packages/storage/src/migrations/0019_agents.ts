// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 多智能体(ADR 0042 第 6 节):新增 agents 表,并给 runs 加两个可为空的列 agent_id、parent_run_id。
 * 不改其他已有表和已有数据;现有的对话与运行不受影响(agent_id 为空就是今天的行为)。
 * 回滚:旧版本不能直接打开已迁移的库(会报 unknown to this version)。唯一办法是停服务,
 * 用 backups/ 里的 db-…-pre-0019.sqlite 恢复再运行旧版本;备份之后写入的数据会丢失。
 */
export const migration0019: Migration = {
    id: 19,
    name: 'agents',
    sql: /* sql */ `
CREATE TABLE agents (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL,
  builtin        INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  system_prompt  TEXT NOT NULL DEFAULT '',
  model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  tool_set_json  TEXT NOT NULL,
  memory_scope   TEXT NOT NULL DEFAULT 'shared' CHECK (memory_scope IN ('shared','own','none')),
  max_depth      INTEGER NOT NULL DEFAULT 2 CHECK (max_depth BETWEEN 0 AND 4),
  max_steps      INTEGER NOT NULL DEFAULT 5 CHECK (max_steps BETWEEN 1 AND 20),
  budget_tokens  INTEGER CHECK (budget_tokens IS NULL OR budget_tokens > 0),
  budget_seconds INTEGER CHECK (budget_seconds IS NULL OR budget_seconds > 0),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (owner_id, name)
);
CREATE UNIQUE INDEX idx_agents_builtin_role ON agents(owner_id, role) WHERE builtin = 1;

ALTER TABLE runs ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
CREATE INDEX idx_runs_parent ON runs(parent_run_id) WHERE parent_run_id IS NOT NULL;
`,
};
