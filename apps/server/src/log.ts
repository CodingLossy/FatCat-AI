// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { pino, type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from './config.js';

export type { Logger };

/**
 * 可能携带凭据的字段,一律替换为 [REDACTED](ADR 0006 第 3 节)。
 * 代码本身也不应把请求体、Cookie、Authorization 头写进日志;这里是兜底。
 */
export const REDACT_PATHS = [
    'password',
    '*.password',
    'token',
    '*.token',
    'apiKey',
    '*.apiKey',
    'authorization',
    '*.authorization',
    'headers.authorization',
    'headers.cookie',
    'cookie',
    '*.cookie',
    'setupCode',
    'csrfToken',
    '*.csrfToken',
];

/** JSON 行日志(time / level / msg + 字段),只写本地,永不外传。 */
export function createLogger(
    options: {
        level?: LogLevel;
        destination?: DestinationStream;
        /** 按值脱敏(例如本进程已加载的模型密钥);在每行写出前调用。 */
        redactLine?: (line: string) => string;
    } = {},
): Logger {
    return pino(
        {
            level: options.level ?? 'info',
            base: null,
            timestamp: pino.stdTimeFunctions.isoTime,
            formatters: { level: (label) => ({ level: label }) },
            redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
            ...(options.redactLine ? { hooks: { streamWrite: options.redactLine } } : {}),
        },
        options.destination,
    );
}
