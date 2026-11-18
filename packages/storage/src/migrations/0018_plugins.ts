// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 插件(ADR 0040 第 7 节):新增 plugins、plugin_events 两张表,并给 tasks 加一个可为空的列 disabled_reason。
 * 不改其他已有表和已有数据。
 * 回滚:旧版本不能直接打开已迁移的库(会报 unknown to this version)。唯一办法是停服务,
 * 用 backups/ 里的 db-…-pre-0018.sqlite 恢复再运行旧版本;备份之后写入的数据会丢失。
 */
export const migration0018: Migration = {
    id: 18,
    name: 'plugins',
    sql: /* sql */ `
CREATE TABLE plugins (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  plugin_id        TEXT NOT NULL,
  version          TEXT NOT NULL,
  previous_version TEXT,
  source_kind      TEXT NOT NULL CHECK (source_kind IN ('local','market')),
  source_ref       TEXT NOT NULL,
  signed_key_id    TEXT,
  content_sha256   TEXT NOT NULL,
  manifest_json    TEXT NOT NULL,
  granted_json     TEXT NOT NULL,
  secret_refs_json TEXT NOT NULL DEFAULT '{}',
  settings_json    TEXT NOT NULL DEFAULT '{}',
  state            TEXT NOT NULL CHECK (state IN
                   ('enabled','disabled','error','incompatible','upgrade-pending','uninstalling','uninstalled')),
  error            TEXT,
  installed_at     TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (owner_id, plugin_id)
);

CREATE TABLE plugin_events (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  plugin_id  TEXT NOT NULL,
  version    TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('installed','upgraded','upgrade-failed','uninstalled','enabled',
             'disabled','stopped','denied','checksum-mismatch','market-rejected','crashed','memory-threshold')),
  detail     TEXT
);
CREATE INDEX idx_plugin_events_owner_at ON plugin_events(owner_id, at, id);

ALTER TABLE tasks ADD COLUMN disabled_reason TEXT;
`,
};
