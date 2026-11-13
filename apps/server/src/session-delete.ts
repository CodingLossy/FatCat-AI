// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 删除会话:先停掉进行中的运行,再删数据库行(消息等随外键级联),最后删附件文件。
// 记忆行保留;出处里指向该会话的列由外键置空(ADR 0007)。单条删除与清空全部走同一条路径。
import type { RunManager } from '@fatcat-ai/agent';
import type { Repositories } from '@fatcat-ai/storage';
import type { AttachmentFiles } from './attachment-files.js';

export async function removeOwnerSessions(
    deps: {
        repos: Repositories;
        runs: RunManager;
        files: AttachmentFiles;
        warn: (err: unknown) => void;
    },
    ownerId: string,
    sessionIds: readonly string[],
): Promise<number> {
    let removed = 0;
    for (const id of sessionIds) {
        const session = deps.repos.sessions.get(ownerId, id);
        if (!session) continue;
        // 停止期间可能又有新运行开始:删除前重新读 activeRunId,直到没有为止
        let activeRunId = session.activeRunId;
        for (let attempt = 0; activeRunId && attempt < 5; attempt++) {
            await deps.runs.stop(activeRunId);
            activeRunId = deps.repos.sessions.get(ownerId, session.id)?.activeRunId ?? null;
        }
        const attachmentIds = deps.repos.attachments.idsForSession(ownerId, session.id);
        if (!deps.repos.sessions.delete(ownerId, session.id)) continue;
        removed++;
        for (const attachmentId of attachmentIds) {
            await deps.files.remove(attachmentId).catch((err: unknown) => deps.warn(err));
        }
    }
    return removed;
}
