// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 魔数比较的内部工具(ADR 0020 第 2 节、ADR 0021 第 3 节);不从包入口导出。

/** 模式中的 null 表示任意字节。 */
export type MagicPattern = readonly (number | null)[];

export function matchesAt(bytes: Uint8Array, pattern: MagicPattern, offset = 0): boolean {
    if (bytes.length < offset + pattern.length) return false;
    return pattern.every((b, i) => b === null || bytes[offset + i] === b);
}

/** 'RIFF' ???? <fourcc>:WebP 与 WAV 共用的容器头。 */
export function isRiff(bytes: Uint8Array, fourcc: string): boolean {
    const tail = [...fourcc].map((c) => c.charCodeAt(0));
    return matchesAt(bytes, [0x52, 0x49, 0x46, 0x46, null, null, null, null, ...tail]);
}
