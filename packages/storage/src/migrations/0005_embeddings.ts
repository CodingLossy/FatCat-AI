// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 嵌入队列与向量映射(ADR 0014)。sqlite-vec 的向量表维度取决于用户的 embed 配置档,不放进静态迁移,
 * 由 embeddings.ts 在第一次嵌入时按维度创建(ADR 0005 第 3 节)。已发布的迁移不得修改。
 */
export const migration0005: Migration = {
    id: 5,
    name: 'embeddings',
    sql: /* sql */ `
CREATE TABLE embed_queue (
  id              INTEGER PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  chunk           INTEGER NOT NULL DEFAULT 0,
  text            TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (item_id, chunk)
);
CREATE INDEX idx_embed_queue_next ON embed_queue(next_attempt_at);

-- id 即向量表的 rowid(vec0 需要整数 rowid);向量表没有外键,删除这里的行时由触发器清理向量
CREATE TABLE embeddings (
  id          INTEGER PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  chunk       INTEGER NOT NULL DEFAULT 0,
  text        TEXT NOT NULL,
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (item_id, chunk)
);
CREATE INDEX idx_embeddings_owner ON embeddings(owner_id);

-- 当前向量表对应的配置:只有一行;换模型或维度后需要手动重建
CREATE TABLE embed_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  profile_id  TEXT,
  model       TEXT NOT NULL,
  dimensions  INTEGER NOT NULL CHECK (dimensions > 0),
  created_at  TEXT NOT NULL
);

CREATE TABLE embed_usage (
  owner_id  TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  day       TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, day)
);
`,
};
