// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 记忆生成日志(ADR 0007 第 5.9 节,开发计划 M6):每次调用模型生成记忆(自动抽取,以后的 sleep 整理)记一行,
 * 只存 id、配置档与模型名、提示词哈希、状态、计数和错误码,不存正文或模型输出。
 * `memory_sources.extract_run_id` 指向产生这条出处的那次运行。已发布的迁移不得修改。
 */
export const migration0012: Migration = {
    id: 12,
    name: 'memory_generation_log',
    sql: /* sql */ `
CREATE TABLE memory_extract_runs (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  job             TEXT NOT NULL CHECK (job IN ('memory.extract', 'memory.sleep')),
  session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  user_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  profile_id      TEXT,
  model           TEXT,
  prompt_version  TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  written         INTEGER NOT NULL DEFAULT 0,
  quarantined     INTEGER NOT NULL DEFAULT 0,
  refused         INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_mem_extract_runs_owner ON memory_extract_runs(owner_id, created_at);
ALTER TABLE memory_sources ADD COLUMN extract_run_id TEXT REFERENCES memory_extract_runs(id) ON DELETE SET NULL;
`,
};
