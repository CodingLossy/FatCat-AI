// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/**
 * 开放插件给成员(ADR 0053 第 4.2 节):管理员装的插件可以标为「开放给成员」,成员的运行里能用它的工具。
 * 只加一列,默认 0,不改已有数据。
 */
export const migration0025: Migration = {
    id: 25,
    name: 'shared_plugins',
    sql: /* sql */ `
ALTER TABLE plugins ADD COLUMN shared_with_members INTEGER NOT NULL DEFAULT 0 CHECK (shared_with_members IN (0, 1));
`,
};
