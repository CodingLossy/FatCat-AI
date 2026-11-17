// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { EventEmitter } from 'node:events';
import type { watch } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestServer, type TestServer } from '../test-helpers.js';
import { createFileWatcher } from './file-watch.js';

let s: TestServer;
beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    s = await createTestServer();
});
afterEach(async () => {
    vi.useRealTimers();
    await s.cleanup();
});

describe('文件变化监听(ADR 0035 第 2 节)', () => {
    it('只监听已授权目录;5 秒内的多次变化合并成一次;任务停用后关闭监听', async () => {
        const ownerId = s.repos.owners.create({ username: 'o', passwordHash: 'x' }).id;
        const root = s.repos.fsRoots.create(ownerId, { path: s.dir, label: 'r' });
        const policy = { maxAttempts: 1, misfire: 'skip', quietHours: null, maxRuntimeMinutes: 5 } as const;
        const task = s.repos.tasks.createUser(ownerId, {
            name: 'w',
            trigger: { kind: 'file_changed', rootId: root.id },
            action: { kind: 'agent_prompt', prompt: 'p' },
            outputs: [{ kind: 'conversation' }],
            policy,
        });
        // 指向不存在的授权目录的任务不会建立监听
        s.repos.tasks.createUser(ownerId, {
            name: 'bad',
            trigger: { kind: 'file_changed', rootId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
            action: { kind: 'agent_prompt', prompt: 'p' },
            outputs: [{ kind: 'conversation' }],
            policy,
        });
        const opened: string[] = [];
        const emitters: EventEmitter[] = [];
        const closed: string[] = [];
        const fakeWatch = ((path: string, _o: unknown, listener: (e: string, n: string) => void) => {
            opened.push(path);
            const em = Object.assign(new EventEmitter(), { close: () => closed.push(path), emitChange: listener });
            emitters.push(em);
            return em;
        }) as unknown as typeof watch;
        const calls: string[] = [];
        const w = createFileWatcher({
            repos: s.repos,
            watchFn: fakeWatch,
            onError: (e) => {
                throw e;
            },
            onChange: (_t, note) => calls.push(note),
        });
        w.sync();
        expect(opened).toEqual([s.dir]);
        const emit = emitters[0] as unknown as { emitChange: (e: string, n: string) => void };
        emit.emitChange('change', 'a.txt');
        emit.emitChange('rename', 'b.txt');
        await vi.advanceTimersByTimeAsync(4000);
        expect(calls).toEqual([]);
        await vi.advanceTimersByTimeAsync(1500);
        expect(calls).toEqual(['Files changed: a.txt, b.txt']);
        s.repos.tasks.update(ownerId, task.id, { enabled: false });
        w.sync();
        expect(closed).toEqual([s.dir]);
        w.stop();
    });
});
