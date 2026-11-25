// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 邀请码与重置码(ADR 0053 第 2 节):管理员生成,一次性、24 小时有效,只存 SHA-256。
 * - `invite`:对方用它设置自己的用户名和密码,建成员账户;`target_owner_id` 为空。
 * - `reset`:成员用它设新密码;`target_owner_id` 是那个成员。
 * `owner_id` 是生成它的管理员;管理员或目标账户被删除时码一起删除。只新增一张表,不改已有数据。
 */
export const migration0023: Migration = {
    id: 23,
    name: 'account_codes',
    sql: /* sql */ `
CREATE TABLE account_codes (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  target_owner_id TEXT REFERENCES owners(id) ON DELETE CASCADE,
  code_hash       TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  used_at         TEXT,
  CHECK ((kind = 'invite') = (target_owner_id IS NULL))
);
CREATE INDEX idx_account_codes_owner ON account_codes(owner_id);
CREATE INDEX idx_account_codes_target ON account_codes(target_owner_id);
`,
};
