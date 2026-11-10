// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';

/** 审批警告(ADR 0016 第 8 节,M3 PR 3):core 生成,JSON 数组;没有警告时为 NULL。已发布的迁移不得修改。 */
export const migration0010: Migration = {
    id: 10,
    name: 'approval_warnings',
    sql: /* sql */ `
ALTER TABLE approval_requests ADD COLUMN warnings_json TEXT;
`,
};
