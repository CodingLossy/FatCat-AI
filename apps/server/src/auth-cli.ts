// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 离线命令(ADR 0027 第 7 节):auth reset-totp [<username>]。验证码与恢复码都丢了时,在服务器本机重置;
// 没有任何远程入口。有多个账户时必须给出用户名,只重置那一个(ADR 0053 第 14 节 PR 6)。
// 输出里只有数量,没有密钥或恢复码。
// auth reset-password <username>(ADR 0053 第 14 节 PR 3):唯一的管理员忘了密码时在服务器本机改密码。
// 新密码从标准输入读(终端里不回显),不出现在命令行参数和 shell 历史里。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Password } from '@fatcat-ai/shared';
import { createAccountRepository, openDatabase, resetTotpOffline } from '@fatcat-ai/storage';
import { hashPassword } from './auth/crypto.js';

export const AUTH_USAGE = `Usage:
  auth reset-totp [<username>]
      Remove an account's TOTP secret and recovery codes, sign out its sessions and write an audit entry.
      The username is required when there is more than one account.
      Run it on the server machine; the server may be running or stopped.
  auth reset-password <username>
      Set a new password for an account (asked for twice, or read from standard input when it is not a terminal).
      Signs out its sessions, revokes its access tokens and devices and writes an audit entry; TOTP is kept.`;

export interface AuthCommandIo {
    dataDir: string;
    out: (line: string) => void;
    err: (line: string) => void;
    now?: () => Date;
    /** 读新密码(reset-password 用);终端里不回显并要求输入两次,管道输入读第一行。null 表示两次不一致或没有输入。 */
    readPassword?: () => Promise<string | null>;
}

/** 返回进程退出码;reset-password 要哈希密码,返回 Promise。 */
export function runAuthCommand(argv: readonly string[], io: AuthCommandIo): number | Promise<number> {
    const [command, ...rest] = argv;
    if (command === 'reset-password') {
        if (rest.length !== 1 || !rest[0]) {
            io.err(`reset-password needs exactly one username\n${AUTH_USAGE}`);
            return 2;
        }
        return resetPassword(rest[0], io);
    }
    if (command !== 'reset-totp' || rest.length > 1 || rest[0] === '') {
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
            const username = rest[0];
            const accounts = createAccountRepository(conn, io.now ?? (() => new Date())).list();
            let ownerId: string | undefined;
            if (username !== undefined) {
                ownerId = accounts.find((a) => a.username === username)?.id;
                if (!ownerId) {
                    io.err(`There is no account named "${username}". Nothing was changed.`);
                    return 1;
                }
            } else if (accounts.length > 1) {
                io.err(`There is more than one account; say whose TOTP to reset: auth reset-totp <username>`);
                return 2;
            }
            const result = resetTotpOffline(conn, io.now, ownerId);
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

async function resetPassword(username: string, io: AuthCommandIo): Promise<number> {
    const dbPath = join(io.dataDir, 'db.sqlite');
    if (!existsSync(dbPath)) {
        io.err('There is no database in the data directory, so there is no account to reset.');
        return 1;
    }
    if (!io.readPassword) {
        io.err('A new password must be typed in or given on standard input.');
        return 2;
    }
    const password = await io.readPassword();
    if (password === null) {
        io.err('The two passwords do not match, or no password was given. Nothing was changed.');
        return 1;
    }
    if (!Password.safeParse(password).success) {
        io.err('The password must be 12 to 256 characters. Nothing was changed.');
        return 1;
    }
    const passwordHash = await hashPassword(password);
    try {
        const conn = openDatabase(dbPath);
        try {
            const result = createAccountRepository(conn, io.now ?? (() => new Date())).setPasswordByUsername(
                username,
                passwordHash,
            );
            if (!result) {
                io.err(`There is no account named "${username}". Nothing was changed.`);
                return 1;
            }
            io.out(
                `The password of "${username}" was changed: its sessions were signed out, its access tokens and devices revoked, audit entry written.`,
            );
            if (result.disabled) io.out('This account is disabled; an admin has to enable it before it can sign in.');
            return 0;
        } finally {
            conn.close();
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // 库还没升级到有账户表的版本(或者被别的进程锁住):不改任何东西
        io.err(
            `Error: ${code ?? 'could not change the password'}. If the server was just upgraded, start it once so the database is updated, then run this again.`,
        );
        return 1;
    }
}

/** 读一行;终端里不回显(每个字符都不显示),Ctrl+C 退出。 */
function readLine(prompt: string, hidden: boolean): Promise<string | null> {
    const stdin = process.stdin;
    return new Promise((resolve) => {
        let text = '';
        const tty = hidden && stdin.isTTY;
        if (tty) {
            process.stderr.write(prompt);
            stdin.setRawMode(true);
        }
        stdin.setEncoding('utf8');
        const done = (value: string | null) => {
            stdin.off('data', onData);
            stdin.off('end', onEnd);
            if (tty) {
                stdin.setRawMode(false);
                process.stderr.write('\n');
            }
            stdin.pause();
            resolve(value);
        };
        const onData = (chunk: string) => {
            for (const ch of chunk) {
                if (ch === '\u0003') {
                    if (tty) stdin.setRawMode(false);
                    process.exit(130);
                }
                if (ch === '\r' || ch === '\n') return done(text);
                if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
                else text += ch;
            }
        };
        const onEnd = () => done(text.length > 0 ? text : null);
        stdin.on('data', onData);
        stdin.on('end', onEnd);
        stdin.resume();
    });
}

/** auth reset-password 的密码输入:终端里输入两次(不回显),管道输入读第一行。 */
export async function readNewPassword(): Promise<string | null> {
    if (!process.stdin.isTTY) return readLine('', false);
    const first = await readLine('New password: ', true);
    if (first === null) return null;
    const second = await readLine('Repeat the new password: ', true);
    return first === second ? first : null;
}
