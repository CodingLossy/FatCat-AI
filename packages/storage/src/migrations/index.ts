// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Migration } from '../migrate.js';
import { migration0001 } from './0001_init.js';
import { migration0002 } from './0002_tools.js';
import { migration0003 } from './0003_fs_roots.js';
import { migration0004 } from './0004_mcp_servers.js';
import { migration0005 } from './0005_embeddings.js';
import { migration0006 } from './0006_knowledge_base.js';
import { migration0007 } from './0007_memory_v2.js';
import { migration0008 } from './0008_kb_roots.js';
import { migration0009 } from './0009_mail.js';
import { migration0010 } from './0010_approval_warnings.js';
import { migration0011 } from './0011_mail_sent_copy.js';
import { migration0012 } from './0012_memory_generation_log.js';

/** 按 id 顺序排列的全部迁移;新增迁移追加在末尾,已发布的迁移不得修改。 */
export const migrations: readonly Migration[] = [
    migration0001,
    migration0002,
    migration0003,
    migration0004,
    migration0005,
    migration0006,
    migration0007,
    migration0008,
    migration0009,
    migration0010,
    migration0011,
    migration0012,
];
