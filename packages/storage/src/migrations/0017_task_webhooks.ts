// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * Webhook 触发器的令牌(ADR 0035 第 4 节):只存令牌的哈希,明文只在生成时显示一次。
 * 只新增一张表,不改已有数据。回滚 = 删除该表(依赖它的 Webhook 任务随之无法被触发)。
 */
export const migration0017: Migration = {
    id: 17,
    name: 'task_webhooks',
    sql: /* sql */ `
CREATE TABLE task_webhook_tokens (
  task_id      TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
`,
};
