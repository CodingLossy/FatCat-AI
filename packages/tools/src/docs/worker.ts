// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 文档解析 worker:每次解析启动一个,结果交回主线程后退出。pdf.js 等解析库只在这里加载,
// 所以主进程的空闲内存不变(M2 方案 PR 5)。
import { parentPort, workerData } from 'node:worker_threads';
import { type DocumentKind, extractDocument } from './extract.js';

interface Job {
    kind: Exclude<DocumentKind, 'text'>;
    data: Uint8Array;
}

const job = workerData as Job;
extractDocument(job.kind, Buffer.from(job.data.buffer, job.data.byteOffset, job.data.byteLength)).then(
    (result) => parentPort!.postMessage({ ok: true, result }),
    (error: unknown) =>
        parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
);
