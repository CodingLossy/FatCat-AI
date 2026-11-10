// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 「已发送」副本策略(ADR 0016 第 14 节,M3 PR 5)。旧的 `append_to_sent` 分不清是预设 / API 默认值还是用户的选择:
 * Web 一直按预设传入、没有开关,API 不传时默认 true。所以旧的 1 记为 `auto`(主机不会自动保存时仍然 APPEND,
 * 行为只在 163 / Gmail 上改变),旧的 0 是明确关闭,记为 `off`。`append_to_sent` 保留,只写不读。
 * 已发布的迁移不得修改。
 */
export const migration0011: Migration = {
    id: 11,
    name: 'mail_sent_copy',
    sql: /* sql */ `
ALTER TABLE mail_accounts ADD COLUMN sent_copy TEXT NOT NULL DEFAULT 'auto'
  CHECK (sent_copy IN ('auto', 'append', 'off'));
UPDATE mail_accounts SET sent_copy = CASE append_to_sent WHEN 0 THEN 'off' ELSE 'auto' END;
`,
};
