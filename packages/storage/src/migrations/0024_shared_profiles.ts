// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 共享模型配置档(ADR 0053 第 5.1 节):管理员可以把自己的配置档标为「共享给成员」,成员能选用,
 * 但看不到地址和密钥引用,也不能编辑或测试。只加一列,默认 0,不改已有数据。
 */
export const migration0024: Migration = {
    id: 24,
    name: 'shared_profiles',
    sql: /* sql */ `
ALTER TABLE model_profiles ADD COLUMN shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1));
`,
};
