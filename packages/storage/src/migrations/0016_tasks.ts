// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 定时任务(ADR 0033 第 6 节):任务与运行记录两张新表,不改已有表。
 * 回滚 = 删除这两张表与索引(先备份数据目录)。已发布的迁移不得修改。
 */
export const migration0016: Migration = {
    id: 16,
    name: 'tasks',
    sql: /* sql */ `
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('user', 'system')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed')),
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  trigger_json TEXT NOT NULL,
  action_json  TEXT NOT NULL,
  outputs_json TEXT NOT NULL DEFAULT '[]',
  policy_json  TEXT NOT NULL,
  system_key  TEXT,
  last_fired_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_tasks_owner_status ON tasks(owner_id, status, enabled);
CREATE UNIQUE INDEX idx_tasks_system_key ON tasks(owner_id, system_key) WHERE system_key IS NOT NULL;

CREATE TABLE task_runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  trigger_reason TEXT NOT NULL CHECK (trigger_reason IN ('schedule', 'catch_up', 'manual', 'event', 'retry')),
  scheduled_for TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'blocked', 'skipped', 'cancelled')),
  attempt       INTEGER NOT NULL DEFAULT 1,
  error_code    TEXT,
  session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  run_id        TEXT,
  outputs_json  TEXT NOT NULL DEFAULT '[]',
  started_at    TEXT,
  finished_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_task_runs_task_created ON task_runs(task_id, created_at DESC, id DESC);
`,
};
