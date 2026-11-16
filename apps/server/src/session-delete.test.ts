// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 删除会话:停止期间不断有新运行开始时,最多重试 5 次,之后照常删除会话与附件,不死循环。
import type { RunManager } from '@fatcat-ai/agent';
import type { Repositories } from '@fatcat-ai/storage';
import { describe, expect, it, vi } from 'vitest';
import type { AttachmentFiles } from './attachment-files.js';
import { removeOwnerSessions } from './session-delete.js';

describe('removeOwnerSessions', () => {
    it('gives up stopping after 5 attempts when a new run keeps starting, then still deletes the session', async () => {
        const stop = vi.fn(() => Promise.resolve());
        const deleted = vi.fn(() => true);
        const remove = vi.fn(() => Promise.resolve());
        const repos = {
            // 每次重新读取时都又有一个活动运行
            sessions: { get: () => ({ id: 's1', activeRunId: 'run-again' }), delete: deleted },
            attachments: { idsForSession: () => ['a1'] },
        } as unknown as Repositories;
        const removed = await removeOwnerSessions(
            {
                repos,
                runs: { stop } as unknown as RunManager,
                files: { remove } as unknown as AttachmentFiles,
                warn: vi.fn(),
            },
            'owner',
            ['s1'],
        );
        expect(stop).toHaveBeenCalledTimes(5);
        expect(deleted).toHaveBeenCalledWith('owner', 's1');
        expect(remove).toHaveBeenCalledWith('a1');
        expect(removed).toBe(1);
    });
});
