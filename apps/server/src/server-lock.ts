// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 数据目录里的服务器锁文件:服务器启动时写入自己的 pid,退出时删除。离线命令(secrets migrate / rekey)
// 发现锁有效就拒绝执行,避免命令行读入 secrets.yaml 之后服务器又写入新的令牌而被静默丢掉(ADR 0026)。
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SERVER_LOCK_FILE = 'server.lock';

/** 进程是否还在:发信号 0 只检查存在性。EPERM 说明进程存在但不属于当前用户。 */
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** 读锁文件;返回仍在运行的服务器 pid,没有锁、锁已过期(进程不在了)或内容无法解析时返回 null。 */
export function runningServerPid(
    dataDir: string,
    alive: (pid: number) => boolean = processAlive,
    self: number = process.pid,
): number | null {
    let pid: unknown;
    try {
        pid = (JSON.parse(readFileSync(join(dataDir, SERVER_LOCK_FILE), 'utf8')) as { pid?: unknown }).pid;
    } catch {
        return null;
    }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === self) return null;
    return alive(pid) ? pid : null;
}

/** 写入本进程的锁;返回释放函数(只删自己写的那份)。写失败时抛错由调用方决定是否忽略。 */
export function acquireServerLock(dataDir: string, pid: number = process.pid, now: () => Date = () => new Date()) {
    const path = join(dataDir, SERVER_LOCK_FILE);
    writeFileSync(path, `${JSON.stringify({ pid, startedAt: now().toISOString() })}\n`, { mode: 0o600 });
    return (): void => {
        try {
            const current = (JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }).pid;
            if (current === pid) rmSync(path, { force: true });
        } catch {
            // 已经不存在或被别人改写:不处理
        }
    };
}

/** 要处理的退出信号:Windows 上关闭控制台窗口、Ctrl+Break 给的是 SIGBREAK。 */
export function shutdownSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
    return platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
}

export interface ShutdownProcess {
    on(event: string, listener: () => void): unknown;
    exit(code?: number): void;
}

/** 拿到锁后立刻调用:`exit` 事件里同步释放锁(rmSync 是同步的),覆盖启动失败的 process.exit、未捕获异常和正常退出。 */
export function installLockRelease(proc: ShutdownProcess, release: () => void): void {
    proc.on('exit', () => release());
}

/**
 * 注册信号处理(锁的 exit 释放由 installLockRelease 负责,必须在拿到锁之后立即注册,不能等到这里):
 * - 第一次收到信号走正常关闭,并设一个定时器:关闭卡住(例如有一直不断开的连接)超时后释放锁并强制退出;
 * - 关闭过程中再收到一次信号(用户又按了一次 Ctrl+C)立即释放锁并退出。
 * 被 SIGKILL / TerminateProcess 直接杀掉时任何处理都不会运行,那种锁由下次启动按「进程已不存在」认出过期(runningServerPid)。
 */
export function installShutdownHandlers(options: {
    proc: ShutdownProcess;
    release: () => void;
    shutdown: (signal: string) => void;
    platform?: NodeJS.Platform;
    forceAfterMs?: number;
    setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown };
}): void {
    const { proc, release, shutdown } = options;
    const setTimer = options.setTimer ?? setTimeout;
    let closing = false;
    for (const signal of shutdownSignals(options.platform)) {
        proc.on(signal, () => {
            if (closing) {
                release();
                proc.exit(1);
                return;
            }
            closing = true;
            setTimer(() => {
                release();
                proc.exit(1);
            }, options.forceAfterMs ?? 10_000).unref?.();
            shutdown(signal);
        });
    }
}
