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
import { migration0013 } from './0013_message_attachments.js';
import { migration0014 } from './0014_channels.js';
import { migration0015 } from './0015_totp.js';
import { migration0016 } from './0016_tasks.js';
import { migration0017 } from './0017_task_webhooks.js';
import { migration0018 } from './0018_plugins.js';
import { migration0019 } from './0019_agents.js';
import { migration0020 } from './0020_devices.js';
import { migration0021 } from './0021_change_log.js';
import { migration0022 } from './0022_accounts.js';
import { migration0023 } from './0023_account_codes.js';
import { migration0024 } from './0024_shared_profiles.js';
import { migration0025 } from './0025_shared_plugins.js';

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
    migration0013,
    migration0014,
    migration0015,
    migration0016,
    migration0017,
    migration0018,
    migration0019,
    migration0020,
    migration0021,
    migration0022,
    migration0023,
    migration0024,
    migration0025,
];
