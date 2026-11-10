// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { z } from 'zod';
import { StorageError } from './db.js';

/** 游标对客户端不透明:内部是 base64url 编码的 JSON(ADR 0004 第 4 节)。 */
export function encodeCursor(value: unknown): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export class InvalidCursorError extends StorageError {}

export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
    try {
        return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    } catch {
        throw new InvalidCursorError('invalid cursor');
    }
}

export interface Page<T> {
    items: T[];
    nextCursor: string | null;
}
