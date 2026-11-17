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

    it('🔒 授权目录被撤销后,即使监听还开着也不再触发任务,并关闭监听', async () => {
        const ownerId = s.repos.owners.create({ username: 'o', passwordHash: 'x' }).id;
        const root = s.repos.fsRoots.create(ownerId, { path: s.dir, label: 'r' });
        s.repos.tasks.createUser(ownerId, {
            name: 'w',
            trigger: { kind: 'file_changed', rootId: root.id },
            action: { kind: 'agent_prompt', prompt: 'p' },
            outputs: [{ kind: 'conversation' }],
            policy: { maxAttempts: 1, misfire: 'skip', quietHours: null, maxRuntimeMinutes: 5 },
        });
        const closed: string[] = [];
        let listener: (e: string, n: string) => void = () => {};
        const fakeWatch = ((path: string, _o: unknown, l: (e: string, n: string) => void) => {
            listener = l;
            return Object.assign(new EventEmitter(), { close: () => closed.push(path) });
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
        s.repos.fsRoots.delete(ownerId, root.id);
        listener('change', 'secret.txt');
        await vi.advanceTimersByTimeAsync(6000);
        expect(calls).toEqual([]);
        expect(closed).toEqual([s.dir]);
        w.stop();
    });
    it('🔒 Windows:根目录被删掉后不停的 rename 事件只记一次错误、关闭监听、不触发任务', async () => {
        const ownerId = s.repos.owners.create({ username: 'o', passwordHash: 'x' }).id;
        const root = s.repos.fsRoots.create(ownerId, { path: s.dir, label: 'r' });
        s.repos.tasks.createUser(ownerId, {
            name: 'w',
            trigger: { kind: 'file_changed', rootId: root.id },
            action: { kind: 'agent_prompt', prompt: 'p' },
            outputs: [{ kind: 'conversation' }],
            policy: { maxAttempts: 1, misfire: 'skip', quietHours: null, maxRuntimeMinutes: 5 },
        });
        const closed: string[] = [];
        let listener: (e: string, n: string) => void = () => {};
        const fakeWatch = ((path: string, _o: unknown, l: (e: string, n: string) => void) => {
            listener = l;
            return Object.assign(new EventEmitter(), { close: () => closed.push(path) });
        }) as unknown as typeof watch;
        const errors: string[] = [];
        const calls: string[] = [];
        let exists = true;
        const w = createFileWatcher({
            repos: s.repos,
            watchFn: fakeWatch,
            existsFn: () => exists,
            onError: (e) => errors.push((e as Error).message),
            onChange: (_t, note) => calls.push(note),
        });
        w.sync();
        listener('rename', 'a.txt'); // 目录还在:正常
        exists = false;
        for (let i = 0; i < 1000; i++) listener('rename', s.dir); // 之后的事件风暴
        await vi.advanceTimersByTimeAsync(6000);
        expect(errors).toHaveLength(1);
        expect(closed).toEqual([s.dir]);
        expect(calls).toEqual([]);
        w.stop();
    });

    it('目录被删掉后定期 sync 只记一次错误且不抛;目录回来后重新监听', () => {
        const ownerId = s.repos.owners.create({ username: 'o', passwordHash: 'x' }).id;
        const root = s.repos.fsRoots.create(ownerId, { path: s.dir, label: 'r' });
        s.repos.tasks.createUser(ownerId, {
            name: 'w',
            trigger: { kind: 'file_changed', rootId: root.id },
            action: { kind: 'agent_prompt', prompt: 'p' },
            outputs: [{ kind: 'conversation' }],
            policy: { maxAttempts: 1, misfire: 'skip', quietHours: null, maxRuntimeMinutes: 5 },
        });
        let opened = 0;
        const fakeWatch = (() => {
            opened++;
            return Object.assign(new EventEmitter(), { close: () => {} });
        }) as unknown as typeof watch;
        const errors: string[] = [];
        let exists = false;
        const w = createFileWatcher({
            repos: s.repos,
            watchFn: fakeWatch,
            existsFn: () => exists,
            onError: (e) => errors.push((e as Error).message),
            onChange: () => {},
        });
        w.sync();
        w.sync();
        expect(opened).toBe(0);
        expect(errors).toHaveLength(1);
        exists = true;
        w.sync();
        w.sync(); // 已在监听:不重复打开
        expect(opened).toBe(1);
        w.stop();
    });
});
