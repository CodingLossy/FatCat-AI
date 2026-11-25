// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 渠道中枢需要的两个服务器函数(ADR 0050 第 2 节):选模型配置档与删除会话,和 Web 的会话路由走同一套代码。
import type { RunManager } from '@fatcat-ai/agent';
import type { ChannelHubOptions } from '@fatcat-ai/channels/hub';
import type { SecretStore } from '@fatcat-ai/providers';
import type { Repositories } from '@fatcat-ai/storage';
import type { AttachmentFiles } from './attachment-files.js';
import { resolveProfile } from './routes/sessions.js';
import { removeOwnerSessions } from './session-delete.js';

export function channelHubServerDeps(deps: {
    repos: Repositories;
    runs: RunManager;
    secrets: SecretStore;
    files: AttachmentFiles;
}): Pick<ChannelHubOptions, 'resolveProfile' | 'removeSessions'> {
    const { repos, runs, secrets, files } = deps;
    return {
        resolveProfile: (ownerId, sessionProfileId) =>
            resolveProfile({ repos, secrets }, ownerId, null, sessionProfileId),
        removeSessions: (ownerId, sessionIds, warn) =>
            removeOwnerSessions({ repos, runs, files, warn }, ownerId, sessionIds),
    };
}
