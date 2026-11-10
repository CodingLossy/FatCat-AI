// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 遍历授权目录:不跟随链接,跳过以 . 开头的名称;有数量与深度上限(ADR 0012 第 3 节)。
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const MAX_ENTRIES_PER_ROOT = 5000;
export const MAX_DEPTH = 8;

export interface WalkEntry {
    path: string;
    parent: string;
    name: string;
    type: 'dir' | 'file';
    size: number;
    mtimeMs: number;
    depth: number;
}

/** 广度优先遍历;返回条目与是否因上限而截断。 */
export function walk(root: string, limits = { entries: MAX_ENTRIES_PER_ROOT, depth: MAX_DEPTH }) {
    const entries: WalkEntry[] = [];
    let truncated = false;
    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 1 }];
    while (queue.length > 0) {
        const { dir, depth } = queue.shift()!;
        let names;
        try {
            names = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        names.sort((a, b) => a.name.localeCompare(b.name));
        for (const d of names) {
            if (d.name.startsWith('.') || d.isSymbolicLink()) continue;
            if (!d.isDirectory() && !d.isFile()) continue;
            if (entries.length >= limits.entries) {
                truncated = true;
                return { entries, truncated };
            }
            const full = path.join(dir, d.name);
            let size: number;
            let mtimeMs: number;
            try {
                const info = lstatSync(full);
                size = info.size;
                mtimeMs = info.mtimeMs;
            } catch {
                continue;
            }
            entries.push({
                path: full,
                parent: dir,
                name: d.name,
                type: d.isDirectory() ? 'dir' : 'file',
                size,
                mtimeMs,
                depth,
            });
            if (d.isDirectory()) {
                if (depth < limits.depth) queue.push({ dir: full, depth: depth + 1 });
                else truncated = true;
            }
        }
    }
    return { entries, truncated };
}
