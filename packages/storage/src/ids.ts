// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { monotonicFactory } from 'ulidx';

const ulid = monotonicFactory();

/** 生成 ULID;同一毫秒内单调递增,保证按 id 排序即按创建顺序(ADR 0005)。 */
export function newId(now: Date = new Date()): string {
    return ulid(now.getTime());
}
