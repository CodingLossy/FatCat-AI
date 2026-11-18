// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    acquireServerLock,
    installShutdownHandlers,
    runningServerPid,
    SERVER_LOCK_FILE,
    shutdownSignals,
} from './server-lock.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'fatcat-lock-'));
    dirs.push(dir);
    return dir;
};

describe('shutdown handlers', () => {
    const fakeProcess = () => {
        const emitter = new EventEmitter();
        const exit = vi.fn();
        return { emitter, exit, proc: { on: emitter.on.bind(emitter), exit } };
    };

    it('handles SIGBREAK on Windows only', () => {
        expect(shutdownSignals('win32')).toContain('SIGBREAK');
        expect(shutdownSignals('linux')).not.toContain('SIGBREAK');
    });

    it('releases the lock on exit, and a second signal releases it and exits at once', () => {
        const { emitter, exit, proc } = fakeProcess();
        const release = vi.fn();
        const shutdown = vi.fn();
        const timers: Array<() => void> = [];
        installShutdownHandlers({
            proc,
            release,
            shutdown,
            platform: 'win32',
            setTimer: (fn) => {
                timers.push(fn);
                return {};
            },
        });
        emitter.emit('SIGBREAK');
        expect(shutdown).toHaveBeenCalledWith('SIGBREAK');
        expect(release).not.toHaveBeenCalled();
        emitter.emit('SIGINT');
        expect(shutdown).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(1);
        emitter.emit('exit');
        expect(release).toHaveBeenCalledTimes(2);
        // 关闭卡住时的定时器:释放锁并强制退出
        timers[0]!();
        expect(exit).toHaveBeenLastCalledWith(0);
    });

    it('a lock released on exit is gone, and a leftover lock of a dead process is recognised as stale', () => {
        const dir = tmp();
        const release = acquireServerLock(dir, 4242);
        expect(runningServerPid(dir, () => true, 1)).toBe(4242);
        expect(runningServerPid(dir, () => false, 1)).toBeNull();
        // 别人改写了锁:不删对方的
        writeFileSync(join(dir, SERVER_LOCK_FILE), JSON.stringify({ pid: 99 }));
        release();
        expect(existsSync(join(dir, SERVER_LOCK_FILE))).toBe(true);
        acquireServerLock(dir, 4242)();
        expect(existsSync(join(dir, SERVER_LOCK_FILE))).toBe(false);
    });
});
