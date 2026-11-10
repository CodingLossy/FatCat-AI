// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 在 worker_threads 中解析文档:按需启动,带内存与时间上限,解析完即退出(M2 方案 PR 5)。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { DocumentKind, ExtractedDocument } from './extract.js';
import { DocumentError } from './zip.js';

export const PARSE_TIMEOUT_MS = 30_000;
/** worker 的老生代堆上限;超出时 worker 被终止,主进程不受影响。 */
export const WORKER_HEAP_MB = 256;
/** 能解析的文件大小上限。 */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** 构建后运行 worker.js;在 Vitest 中直接运行源码 worker.ts(借助 tsx 加载)。 */
function workerEntry(): { url: URL; execArgv: string[] } {
    const js = new URL('./worker.js', import.meta.url);
    if (existsSync(fileURLToPath(js))) return { url: js, execArgv: [] };
    return { url: new URL('./worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] };
}

export interface ParseOptions {
    timeoutMs?: number;
    heapMb?: number;
}

export function parseInWorker(
    kind: Exclude<DocumentKind, 'text'>,
    data: Buffer,
    options: ParseOptions = {},
): Promise<ExtractedDocument> {
    if (data.length > MAX_DOCUMENT_BYTES) {
        return Promise.reject(new DocumentError(`the document is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`));
    }
    const { url, execArgv } = workerEntry();
    return new Promise((resolve, reject) => {
        const worker = new Worker(url, {
            workerData: { kind, data: new Uint8Array(data) },
            execArgv,
            resourceLimits: { maxOldGenerationSizeMb: options.heapMb ?? WORKER_HEAP_MB },
        });
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
            void worker.terminate();
        };
        const timer = setTimeout(
            () => finish(() => reject(new DocumentError('parsing the document took too long'))),
            options.timeoutMs ?? PARSE_TIMEOUT_MS,
        );
        worker.on('message', (message: { ok: true; result: ExtractedDocument } | { ok: false; error: string }) =>
            finish(() => (message.ok ? resolve(message.result) : reject(new DocumentError(message.error)))),
        );
        worker.on('error', (error) =>
            finish(() =>
                reject(
                    new DocumentError(
                        /heap|memory/i.test(error.message)
                            ? 'the document needs too much memory to parse'
                            : `parsing failed: ${error.message}`,
                    ),
                ),
            ),
        );
        worker.on('exit', (code) =>
            finish(() => reject(new DocumentError(`the parser stopped unexpectedly (exit code ${code})`))),
        );
    });
}
