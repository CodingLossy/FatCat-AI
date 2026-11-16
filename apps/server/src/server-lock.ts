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
