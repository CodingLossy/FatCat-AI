// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * TOTP 两步验证(ADR 0027 第 8 节):共享密钥(ADR 0026 信封,主密钥加密)、一次性恢复码(加盐哈希),
 * 以及会话上的「通过第二因素」时间。只新增两张表与一列,不改已有数据。已发布的迁移不得修改。
 */
export const migration0015: Migration = {
    id: 15,
    name: 'totp',
    sql: /* sql */ `
CREATE TABLE totp_credentials (
  owner_id        TEXT PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  secret_enc      TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  last_used_step  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  enabled_at      TEXT
);

CREATE TABLE totp_recovery_codes (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  salt       TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_totp_recovery_owner ON totp_recovery_codes(owner_id);

ALTER TABLE auth_sessions ADD COLUMN second_factor_at TEXT;
`,
};
