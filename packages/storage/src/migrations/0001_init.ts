// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * M1 初始结构(ADR 0005 第 5 节、ADR 0007 的 M1 子集)。
 * 已发布的迁移不得修改:迁移器会校验 SQL 的校验和。新的结构变更请新增迁移文件。
 */
export const migration0001: Migration = {
    id: 1,
    name: 'init',
    sql: /* sql */ `
-- 主人账户(1.0 仅单用户,2.0 迁移时去掉单行触发器)
CREATE TABLE owners (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TRIGGER trg_owners_single BEFORE INSERT ON owners
  WHEN (SELECT count(*) FROM owners) >= 1
BEGIN
  SELECT RAISE(ABORT, 'only one owner is allowed in 1.0');
END;

CREATE TABLE auth_sessions (
  id           TEXT PRIMARY KEY,               -- 会话令牌的 SHA-256
  owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  csrf_hash    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_auth_sessions_owner ON auth_sessions(owner_id);

CREATE TABLE access_tokens (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
);
CREATE INDEX idx_access_tokens_owner ON access_tokens(owner_id);

CREATE TABLE model_profiles (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('openai-compatible','anthropic','gemini')),
  base_url       TEXT,
  api_key_ref    TEXT,                          -- 只存 env:/file: 引用,从不存明文(ADR 0006)
  model          TEXT NOT NULL,
  purpose_json   TEXT NOT NULL,
  context_window INTEGER,
  params_json    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_model_profiles_owner ON model_profiles(owner_id);

CREATE TABLE settings (
  owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);

CREATE TABLE sessions (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  title                  TEXT NOT NULL DEFAULT '',
  model_profile_id       TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  forked_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  forked_from_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  last_message_at        TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX idx_sessions_owner_updated ON sessions(owner_id, updated_at DESC, id DESC);

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner_id          TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL CHECK (seq >= 1),
  role              TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  parts_json        TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('streaming','complete','error','cancelled')),
  run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,
  parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  model_profile_id  TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  client_message_id TEXT,
  usage_json        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE UNIQUE INDEX ux_messages_client_id ON messages(session_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
CREATE INDEX idx_messages_run ON messages(run_id);

CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner_id          TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  status            TEXT NOT NULL
                    CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','cancelled')),
  input_message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  output_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  error_json        TEXT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT
);
CREATE INDEX idx_runs_session ON runs(session_id, started_at);
CREATE INDEX idx_runs_active ON runs(owner_id, status) WHERE finished_at IS NULL;

-- 事件:seq 全局单调递增,SSE 与 WebSocket 共用(ADR 0004)
CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  session_id   TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  run_id       TEXT REFERENCES runs(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_events_owner_seq ON events(owner_id, seq);
CREATE INDEX idx_events_run_seq ON events(run_id, seq);

-- 旧轮次的压缩摘要;原文仍在 messages(《记忆模块补充设计》2.2)
CREATE TABLE session_summaries (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  from_seq   INTEGER NOT NULL,
  to_seq     INTEGER NOT NULL,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, from_seq),
  CHECK (from_seq <= to_seq)
);

-- 统一条目索引(ADR 0003;M1 只建表,知识地图 API 在 M2)
CREATE TABLE items (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('category','content')),
  type             TEXT NOT NULL,
  source           TEXT NOT NULL,
  source_ref       TEXT,
  title            TEXT NOT NULL,
  summary          TEXT,
  icon             TEXT,
  color            TEXT,
  child_count      INTEGER NOT NULL DEFAULT 0,
  descendant_count INTEGER NOT NULL DEFAULT 0,
  meta             TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE UNIQUE INDEX ux_items_source_ref ON items(owner_id, source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX idx_items_type ON items(owner_id, type, updated_at);

CREATE TABLE item_edges (
  parent_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  child_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  rel          TEXT NOT NULL DEFAULT 'contains',
  position     INTEGER,
  primary_edge INTEGER NOT NULL DEFAULT 0 CHECK (primary_edge IN (0,1)),
  PRIMARY KEY (parent_id, child_id, rel)
);
CREATE INDEX idx_edges_child ON item_edges(child_id);
-- 每个条目最多一条 primary 边(严格树)
CREATE UNIQUE INDEX ux_edges_primary_child ON item_edges(child_id) WHERE primary_edge = 1;

-- 全文检索:外部内容表 + 触发器同步;trigram 分词支持中文(少于 3 字的查询由应用层 LIKE 回退)
CREATE VIRTUAL TABLE items_fts USING fts5(
  title, summary,
  content = 'items', content_rowid = 'rowid',
  tokenize = 'trigram'
);
CREATE TRIGGER trg_items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END;
CREATE TRIGGER trg_items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary);
END;
CREATE TRIGGER trg_items_fts_au AFTER UPDATE OF title, summary ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary);
  INSERT INTO items_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END;

-- 记忆 v1(ADR 0007 的 M1 子集;其余列在 M2 用 ADD COLUMN 补齐)
CREATE TABLE memory_facts (
  item_id     TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  mem_type    TEXT NOT NULL CHECK (mem_type IN ('episodic','semantic','procedural')),
  subtype     TEXT CHECK (subtype IN ('profile','preference','decision','task','relation')),
  entity_key  TEXT,
  cardinality TEXT NOT NULL DEFAULT 'multi' CHECK (cardinality IN ('single','multi')),
  value_json  TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','superseded','conflicted','retracted','expired')),
  domain      TEXT NOT NULL DEFAULT 'general' CHECK (domain IN ('work','life','general')),
  sensitivity INTEGER NOT NULL DEFAULT 0 CHECK (sensitivity BETWEEN 0 AND 2),
  confidence  REAL NOT NULL DEFAULT 0.7 CHECK (confidence BETWEEN 0 AND 1),
  origin      TEXT NOT NULL CHECK (origin IN ('user_explicit','extracted','consolidated','manual','imported')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_mem_single_active ON memory_facts(owner_id, entity_key)
  WHERE entity_key IS NOT NULL AND cardinality = 'single' AND status = 'active';
CREATE INDEX idx_mem_lookup ON memory_facts(owner_id, status, mem_type);
CREATE INDEX idx_mem_entity ON memory_facts(owner_id, entity_key);

CREATE TABLE memory_sources (
  id                TEXT PRIMARY KEY,
  memory_id         TEXT NOT NULL REFERENCES memory_facts(item_id) ON DELETE CASCADE,
  session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  user_message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,
  answer_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  source_item_id    TEXT REFERENCES items(id) ON DELETE SET NULL,
  excerpt           TEXT CHECK (excerpt IS NULL OR length(excerpt) <= 300),
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_memsrc_mem ON memory_sources(memory_id);
`,
};
