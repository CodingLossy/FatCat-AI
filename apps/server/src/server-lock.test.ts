// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    acquireServerLock,
    installLockRelease,
    installShutdownHandlers,
    processImage,
    runningServerPid,
    selfImage,
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
        // 信号处理不再注册 exit(由 installLockRelease 负责)
        emitter.emit('exit');
        expect(release).toHaveBeenCalledTimes(1);
        // 关闭卡住时的定时器:释放锁并以非 0 退出
        timers[0]!();
        expect(release).toHaveBeenCalledTimes(2);
        expect(exit).toHaveBeenLastCalledWith(1);
    });

    it('installLockRelease releases on exit right after the lock is taken; releasing twice is harmless', () => {
        const dir = tmp();
        const { emitter, proc } = fakeProcess();
        const release = acquireServerLock(dir, 4242);
        installLockRelease(proc, release);
        emitter.emit('exit');
        expect(existsSync(join(dir, SERVER_LOCK_FILE))).toBe(false);
        writeFileSync(join(dir, SERVER_LOCK_FILE), JSON.stringify({ pid: 7 }));
        emitter.emit('exit');
        expect(existsSync(join(dir, SERVER_LOCK_FILE))).toBe(true);
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

    it('a leftover lock whose pid now belongs to another program is stale (Windows reuses pids quickly)', () => {
        const dir = tmp();
        acquireServerLock(dir, 4242, undefined, 'node.exe');
        expect(
            runningServerPid(
                dir,
                () => true,
                1,
                () => 'node.exe',
            ),
        ).toBe(4242);
        expect(
            runningServerPid(
                dir,
                () => true,
                1,
                () => 'Explorer.EXE',
            ),
        ).toBeNull();
        // 查不到映像名时宁可当它还在运行
        expect(
            runningServerPid(
                dir,
                () => true,
                1,
                () => null,
            ),
        ).toBe(4242);
        // 旧版本写的锁没有 image:只看进程在不在
        writeFileSync(join(dir, SERVER_LOCK_FILE), JSON.stringify({ pid: 4242 }));
        expect(
            runningServerPid(
                dir,
                () => true,
                1,
                () => 'explorer.exe',
            ),
        ).toBe(4242);
    });

    it('reads the image name from tasklist on Windows only, and gives up on anything unexpected', () => {
        const tasklist = (out: string) => () => out;
        expect(processImage(4242, 'win32', tasklist('"Node.exe","4242","Console","1","45,000 K"\r\n'))).toBe(
            'node.exe',
        );
        expect(
            processImage(4242, 'win32', tasklist('INFO: No tasks are running which match the criteria.')),
        ).toBeNull();
        expect(processImage(4242, 'win32', tasklist('"node.exe","42","Console","1","45,000 K"'))).toBeNull();
        expect(
            processImage(4242, 'win32', () => {
                throw new Error('tasklist missing');
            }),
        ).toBeNull();
        const run = vi.fn(() => '');
        expect(processImage(4242, 'linux', run)).toBeNull();
        expect(run).not.toHaveBeenCalled();
    });

    it.runIf(process.platform === 'win32')('finds this test process by its real image name on Windows', () => {
        expect(processImage(process.pid)).toBe(selfImage());
    });
});
