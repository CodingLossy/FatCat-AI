// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 离线命令(ADR 0027 第 7 节):auth reset-totp。验证码与恢复码都丢了时,在服务器本机重置;没有任何远程入口。
// 输出里只有数量,没有密钥或恢复码。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, resetTotpOffline } from '@fatcat-ai/storage';

export const AUTH_USAGE = `Usage:
  auth reset-totp
      Remove the TOTP secret and recovery codes, sign out every session and write an audit entry.
      Run it on the server machine; the server may be running or stopped.`;

export interface AuthCommandIo {
    dataDir: string;
    out: (line: string) => void;
    err: (line: string) => void;
    now?: () => Date;
}

/** 返回进程退出码。 */
export function runAuthCommand(argv: readonly string[], io: AuthCommandIo): number {
    const [command, ...rest] = argv;
    if (command !== 'reset-totp' || rest.length > 0) {
        io.err(
            `${command && command !== 'reset-totp' ? `unknown command "${command}"` : 'unexpected arguments'}\n${AUTH_USAGE}`,
        );
        return 2;
    }
    const dbPath = join(io.dataDir, 'db.sqlite');
    if (!existsSync(dbPath)) {
        io.err('There is no database in the data directory, so there is nothing to reset.');
        return 1;
    }
    try {
        const conn = openDatabase(dbPath);
        try {
            const result = resetTotpOffline(conn, io.now);
            if (result.credentials === 0) {
                io.out('TOTP is not set up; nothing was changed.');
            } else {
                io.out(
                    `TOTP was reset: credentials removed, ${result.sessions} session(s) signed out, audit entry written.`,
                );
                io.out('Sign in with your password, then turn TOTP on again from Settings → Security.');
            }
        } finally {
            conn.close();
        }
        return 0;
    } catch (error) {
        io.err(`Error: ${(error as NodeJS.ErrnoException).code ?? 'could not reset TOTP'}`);
        return 1;
    }
}
