// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 图片附件(ADR 0020 第 3 节):文件在数据目录 attachments/ 下,以 id 命名;这里只存元数据与 SHA-256。
 * message_id 为 NULL 表示已上传、尚未随消息发送。model_profiles.vision 为用户勾选的「支持图片」。
 * 已发布的迁移不得修改。
 */
export const migration0013: Migration = {
    id: 13,
    name: 'message_attachments',
    sql: /* sql */ `
CREATE TABLE message_attachments (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  message_id  TEXT REFERENCES messages(id) ON DELETE CASCADE,
  media_type  TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  bytes       INTEGER NOT NULL CHECK (bytes > 0),
  sha256      TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_attachments_message ON message_attachments(message_id);
CREATE INDEX idx_attachments_unlinked ON message_attachments(created_at) WHERE message_id IS NULL;
ALTER TABLE model_profiles ADD COLUMN vision INTEGER NOT NULL DEFAULT 0 CHECK (vision IN (0, 1));
`,
};
