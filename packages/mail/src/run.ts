// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 在独立的子进程中运行邮件任务:按需启动,带内存与时间上限,完成即退出。
// 不用 worker_threads:实测 worker 退出后,它用过的内存大多仍算在主进程的 RSS 里(每次同步后约多 60 MiB),
// 子进程退出时内存全部还给系统,服务器的空闲 RSS 不变(ADR 0016 第 2 节)。
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MailConnectionTest } from '@fatcat-ai/shared';
import type { DownloadInput, ImapConnectOptions, SendInput, SendOutput, SyncInput, SyncOutput } from './types.js';

export type MailJob =
    | { kind: 'sync'; input: SyncInput }
    | { kind: 'test'; imap: ImapConnectOptions; smtp: ImapConnectOptions }
    | { kind: 'send'; input: SendInput }
    | { kind: 'download'; input: DownloadInput };

export type MailJobResult<J extends MailJob> = J extends { kind: 'sync' }
    ? SyncOutput
    : J extends { kind: 'send' }
      ? SendOutput
      : J extends { kind: 'download' }
        ? Uint8Array
        : MailConnectionTest;

/** 执行邮件任务的函数;服务器默认用子进程,测试中注入内存实现。 */
export type MailJobRunner = <J extends MailJob>(job: J) => Promise<MailJobResult<J>>;

export class MailJobError extends Error {}

export const JOB_TIMEOUT_MS = 5 * 60_000;
export const CHILD_HEAP_MB = 192;

/** 子进程只拿到运行所需的环境变量,不继承服务器的其他配置与密钥引用。 */
const ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'NODE_EXTRA_CA_CERTS', 'TZ', 'LANG'];

/** 构建后运行 worker.js;在 Vitest 中直接运行源码 worker.ts(借助 tsx 加载)。 */
function workerEntry(): { path: string; execArgv: string[] } {
    const js = fileURLToPath(new URL('./worker.js', import.meta.url));
    if (existsSync(js)) return { path: js, execArgv: [] };
    return { path: fileURLToPath(new URL('./worker.ts', import.meta.url)), execArgv: ['--import', 'tsx'] };
}

export const runInWorker: MailJobRunner = (job) => {
    const { path, execArgv } = workerEntry();
    const env: NodeJS.ProcessEnv = {};
    for (const key of ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
    return new Promise((resolve, reject) => {
        const child = fork(path, [], {
            execArgv: [...execArgv, `--max-old-space-size=${CHILD_HEAP_MB}`],
            env,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            serialization: 'advanced',
        });
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
            if (child.exitCode === null) child.kill();
        };
        const timer = setTimeout(
            () => finish(() => reject(new MailJobError('The mail server did not finish in time.'))),
            JOB_TIMEOUT_MS,
        );
        child.on('message', (m: { ok: true; result: never } | { ok: false; error: string }) =>
            finish(() => (m.ok ? resolve(m.result) : reject(new MailJobError(m.error)))),
        );
        child.on('error', (error) => finish(() => reject(new MailJobError(`Mail worker failed: ${error.message}`))));
        child.on('exit', (code, signal) =>
            finish(() =>
                reject(
                    new MailJobError(
                        `The mail worker stopped unexpectedly (${signal ?? `exit code ${code}`}); it may have run out of memory.`,
                    ),
                ),
            ),
        );
        child.send(job);
    });
};
