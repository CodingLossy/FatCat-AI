// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { createInterface, type Interface } from 'node:readline';

/** 命令运行时的输入输出;测试中替换成内存流。 */
export interface Ctx {
    env: NodeJS.ProcessEnv;
    stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream & { isTTY?: boolean };
    /** 注册 Ctrl+C 处理;返回取消注册函数。 */
    onInterrupt: (handler: () => void) => () => void;
}

export const processCtx = (): Ctx => ({
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    onInterrupt: (handler) => {
        process.on('SIGINT', handler);
        return () => process.off('SIGINT', handler);
    },
});

/** 用法错误(退出码 2)。 */
export class UsageError extends Error {
    override name = 'UsageError';
}

export const isInteractive = (ctx: Ctx) => Boolean(ctx.stdin.isTTY && ctx.stderr.isTTY);

export function status(ctx: Ctx, message: string): void {
    ctx.stderr.write(`${message}\n`);
}

/** 读完 stdin(用于 --stdin / --password-stdin)。 */
export async function readAll(ctx: Ctx): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of ctx.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    return Buffer.concat(chunks).toString('utf8');
}

export function lineReader(ctx: Ctx): Interface {
    return createInterface({ input: ctx.stdin, output: ctx.stderr, terminal: isInteractive(ctx) });
}

export function ask(rl: Interface, question: string): Promise<string | null> {
    return new Promise((resolve) => {
        const onClose = () => resolve(null);
        rl.once('close', onClose);
        rl.question(question, (answer) => {
            rl.off('close', onClose);
            resolve(answer);
        });
    });
}

/** 在终端里静默读取密码(不回显);非终端时请用 --password-stdin。 */
export function readHidden(ctx: Ctx, prompt: string): Promise<string> {
    if (!ctx.stdin.isTTY || !ctx.stdin.setRawMode) {
        return Promise.reject(new UsageError('Not a terminal: pipe the password with --password-stdin'));
    }
    const stdin = ctx.stdin;
    ctx.stderr.write(prompt);
    stdin.setRawMode!(true);
    stdin.resume();
    return new Promise((resolve, reject) => {
        let value = '';
        const done = (error?: Error) => {
            stdin.setRawMode!(false);
            stdin.pause();
            stdin.off('data', onData);
            ctx.stderr.write('\n');
            if (error) reject(error);
            else resolve(value);
        };
        const onData = (chunk: Buffer | string) => {
            for (const ch of String(chunk)) {
                if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
                if (ch === '\u0003') return done(new UsageError('Cancelled'));
                if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
                else if (ch >= ' ') value += ch;
            }
        };
        stdin.on('data', onData);
    });
}

/** 取用户名:参数优先,否则在终端里询问。 */
export async function promptLine(ctx: Ctx, question: string): Promise<string> {
    if (!isInteractive(ctx)) throw new UsageError(`Missing value: ${question.replace(/:\s*$/, '')}`);
    const rl = lineReader(ctx);
    try {
        const answer = await ask(rl, question);
        if (answer === null) throw new UsageError('Cancelled');
        return answer.trim();
    } finally {
        rl.close();
    }
}
