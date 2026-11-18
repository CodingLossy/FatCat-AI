// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

/**
 * 桌面壳以 sidecar 方式启动核心时,壳把子进程的 stdin 接成管道。壳退出(正常或崩溃)后管道关闭,
 * 核心据此走正常关闭流程,避免残留进程占着端口和数据库锁。仅在 FATCAT_AI_EXIT_WITH_PARENT=1 时启用。
 */
export interface ParentStdin {
    on(event: 'end' | 'close', listener: () => void): unknown;
    resume(): unknown;
}

export function watchParentExit(options: {
    env: Record<string, string | undefined>;
    stdin: ParentStdin;
    onParentExit: () => void;
}): boolean {
    if (options.env['FATCAT_AI_EXIT_WITH_PARENT'] !== '1') return false;
    let fired = false;
    const fire = () => {
        if (fired) return;
        fired = true;
        options.onParentExit();
    };
    options.stdin.on('end', fire);
    options.stdin.on('close', fire);
    options.stdin.resume();
    return true;
}
