// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/** 本地知识库的分块与全文索引(ADR 0015)。已发布的迁移不得修改。 */
export const migration0006: Migration = {
    id: 6,
    name: 'knowledge_base',
    sql: /* sql */ `
-- 每个已索引的文件一行:mtime 与 size 不变时不重新分块
CREATE TABLE kb_sources (
  item_id     TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  mtime       TEXT,
  size        INTEGER,
  chunk_chars INTEGER NOT NULL,
  chunks      INTEGER NOT NULL,
  error       TEXT,
  indexed_at  TEXT NOT NULL
);

CREATE TABLE kb_chunks (
  id        INTEGER PRIMARY KEY,
  owner_id  TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  item_id   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  chunk     INTEGER NOT NULL,
  page      INTEGER,
  heading   TEXT,
  text      TEXT NOT NULL,
  UNIQUE (item_id, chunk)
);

CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
  text, heading,
  content = 'kb_chunks', content_rowid = 'id',
  tokenize = 'trigram'
);
CREATE TRIGGER trg_kb_chunks_fts_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
END;
CREATE TRIGGER trg_kb_chunks_fts_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, old.heading);
END;
`,
};
