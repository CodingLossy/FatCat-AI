// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * IM 渠道(ADR 0022 第 10 节):渠道配置(config_json 只含 env: / file: 引用)、绑定的主人账号、
 * 配对码(只存哈希)、入站去重(3 天后清理)。状态计数只在内存里,不落库。已发布的迁移不得修改。
 */
export const migration0014: Migration = {
    id: 14,
    name: 'channels',
    sql: /* sql */ `
CREATE TABLE channels (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  label            TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  session_id       TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  notify_degraded  INTEGER NOT NULL DEFAULT 0 CHECK (notify_degraded IN (0, 1)),
  config_json      TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_channels_owner ON channels(owner_id);
CREATE TABLE channel_bindings (
  channel_id        TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  external_user_id  TEXT NOT NULL,
  bound_at          TEXT NOT NULL
);
CREATE TABLE channel_pairings (
  channel_id       TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  code_hash        TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  failed_attempts  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE channel_inbox (
  channel_id           TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_message_id  TEXT NOT NULL,
  received_at          TEXT NOT NULL,
  PRIMARY KEY (channel_id, external_message_id)
) WITHOUT ROWID;
CREATE INDEX idx_channel_inbox_received ON channel_inbox(received_at);
`,
};
