// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 数据目录里的服务器锁文件:服务器启动时写入自己的 pid,退出时删除。离线命令(secrets migrate / rekey)
// 发现锁有效就拒绝执行,避免命令行读入 secrets.yaml 之后服务器又写入新的令牌而被静默丢掉(ADR 0026)。
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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

/** 本进程的映像名(node.exe、fatcat-server.exe 等),小写;写进锁文件,用来认出 pid 被别的程序复用。 */
export function selfImage(execPath: string = process.execPath): string {
    return basename(execPath).toLowerCase();
}

/**
 * 查某个 pid 当前的映像名,查不到时返回 null(调用方按「仍在运行」处理,宁可误拦也不放过)。
 * 只在 Windows 上查:被 TerminateProcess 杀掉的服务器来不及删锁,Windows 又很快复用 pid,
 * 只看「进程在不在」会把别的程序当成服务器(HANDOFF 的 server.lock 残留)。POSIX 上沿用 kill 0。
 */
export function processImage(
    pid: number,
    platform: NodeJS.Platform = process.platform,
    run: (file: string, args: string[]) => string = (file, args) =>
        execFileSync(file, args, { encoding: 'utf8', timeout: 5000, windowsHide: true }),
): string | null {
    if (platform !== 'win32') return null;
    try {
        // 输出形如 "node.exe","1234","Console","1","45,000 K";没有这个进程时是一行提示,不以引号开头
        const line =
            run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
                .trim()
                .split(/\r?\n/)[0] ?? '';
        const match = /^"([^"]+)","(\d+)"/.exec(line);
        return match && Number(match[2]) === pid ? match[1]!.toLowerCase() : null;
    } catch {
        return null;
    }
}

/**
 * 读锁文件;返回仍在运行的服务器 pid,没有锁、锁已过期(进程不在了,或 pid 已被别的程序复用)
 * 或内容无法解析时返回 null。
 */
export function runningServerPid(
    dataDir: string,
    alive: (pid: number) => boolean = processAlive,
    self: number = process.pid,
    imageOf: (pid: number) => string | null = processImage,
): number | null {
    let lock: { pid?: unknown; image?: unknown };
    try {
        lock = JSON.parse(readFileSync(join(dataDir, SERVER_LOCK_FILE), 'utf8')) as typeof lock;
    } catch {
        return null;
    }
    const pid = lock.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === self) return null;
    if (!alive(pid)) return null;
    // 旧版本写的锁没有 image:只能按「进程在」处理
    if (typeof lock.image === 'string') {
        const current = imageOf(pid);
        // Windows 的映像名不区分大小写:锁里的 NODE.EXE 与现在查到的 node.exe 是同一个程序
        if (current !== null && current.toLowerCase() !== lock.image.toLowerCase()) return null;
    }
    return pid;
}

/** 写入本进程的锁;返回释放函数(只删自己写的那份)。写失败时抛错由调用方决定是否忽略。 */
export function acquireServerLock(
    dataDir: string,
    pid: number = process.pid,
    now: () => Date = () => new Date(),
    image: string = selfImage(),
) {
    const path = join(dataDir, SERVER_LOCK_FILE);
    writeFileSync(path, `${JSON.stringify({ pid, image, startedAt: now().toISOString() })}\n`, { mode: 0o600 });
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
