// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 设备配对与设备令牌(ADR 0045 第 1 节):新增 pairing_codes、devices、device_tokens、device_events 四张表。
 * 只新增表,不改任何已有表和已有数据(审计事件放在自己的 device_events 里,不动 audit_log 的 CHECK)。
 * 令牌与配对码只存 SHA-256,明文从不落库。
 * 回滚:旧版本不能直接打开已迁移的库(会报 unknown to this version)。唯一办法是停服务,
 * 用 backups/ 里的 db-…-pre-0020.sqlite 恢复再运行旧版本;备份之后写入的数据会丢失。
 */
export const migration0020: Migration = {
    id: 20,
    name: 'devices',
    sql: /* sql */ `
CREATE TABLE pairing_codes (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX idx_pairing_codes_owner ON pairing_codes(owner_id, expires_at);

CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT,
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('owner','replay','self'))
);
CREATE INDEX idx_devices_owner ON devices(owner_id, created_at);

CREATE TABLE device_tokens (
  token_hash TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX idx_device_tokens_device ON device_tokens(device_id);

CREATE TABLE device_events (
  id        TEXT PRIMARY KEY,
  owner_id  TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  device_id TEXT,
  at        TEXT NOT NULL,
  event     TEXT NOT NULL CHECK (event IN
            ('pairing-code-created','paired','pairing-failed','refreshed','replay-revoked','renamed','revoked','self-revoked')),
  summary   TEXT NOT NULL
);
CREATE INDEX idx_device_events_owner_at ON device_events(owner_id, at, id);
`,
};
