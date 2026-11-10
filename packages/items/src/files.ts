// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// files 提供者:「文件」→ 授权目录 → 文件夹 → 文件(ADR 0012 第 3 节)。
// source_ref 为「授权目录 id:真实路径」,同一个文件出现在嵌套的两个授权目录下时也不会冲突。
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Item, ItemContent } from '@fatcat-ai/shared';
import { documentKind, DocumentError, MAX_DOCUMENT_BYTES, parseInWorker, resolveInRoots } from '@fatcat-ai/tools';
import { type ItemProvider, MAX_CONTENT_CHARS, type OpenContext, type SyncContext, textContent } from './provider.js';
import { walk } from './walk.js';

export const FILES_ROOT_REF = 'files';
const MAX_TEXT_BYTES = 256 * 1024;

/** 从 source_ref 中取出真实路径(去掉授权目录 id 前缀)。 */
export function pathOfRef(ref: string): string {
    const i = ref.indexOf(':');
    // ULID 不含冒号,所以第一个冒号之后就是路径(Windows 盘符的冒号在其后)
    return i >= 0 ? ref.slice(i + 1) : ref;
}

function readPrefix(file: string, length: number): Buffer {
    const fd = openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(length);
        return buffer.subarray(0, readSync(fd, buffer, 0, length, 0));
    } finally {
        closeSync(fd);
    }
}

/**
 * 读取授权目录内的文件正文:先按 ADR 0011 的规则重新校验路径(不在授权目录内时抛出 PathError,即 ToolDeniedError),
 * 文档在 worker 中解析,文本最多 256 KB。
 */
export async function readAuthorizedFile(
    file: string,
    roots: string[],
): Promise<{ path: string; text: string; truncated: boolean }> {
    const { path: real } = resolveInRoots(file, roots);
    const info = statSync(real);
    if (!info.isFile()) throw new DocumentError('not a file');
    const kind = documentKind(real);
    if (kind) {
        if (info.size > MAX_DOCUMENT_BYTES) throw new DocumentError('the document is too large');
        const doc = await parseInWorker(kind, readPrefix(real, info.size));
        return { path: real, text: doc.text, truncated: false };
    }
    const buffer = readPrefix(real, Math.min(info.size, MAX_TEXT_BYTES));
    if (buffer.subarray(0, 8192).includes(0))
        throw new DocumentError('this is a binary file and cannot be shown as text');
    return { path: real, text: buffer.toString('utf8'), truncated: info.size > MAX_TEXT_BYTES };
}

export const filesProvider: ItemProvider = {
    id: 'files',
    async sync(ctx: SyncContext) {
        const top = ctx.upsert({
            sourceRef: FILES_ROOT_REF,
            kind: 'category',
            type: 'files',
            title: '文件',
            icon: 'folder',
            parentId: null,
        });
        const keepRoots = new Set<string>();
        for (const [index, root] of ctx.roots.entries()) {
            const ref = `${root.id}:${root.path}`;
            keepRoots.add(ref);
            const { entries, truncated } = walk(root.path);
            const rootItem = ctx.upsert({
                sourceRef: ref,
                kind: 'category',
                type: 'files.root',
                title: root.label,
                summary: root.path,
                meta: { path: root.path, ...(truncated ? { truncated: true } : {}) },
                parentId: top.id,
                position: index,
            });
            // 父目录在前(广度优先),所以子项登记时父项已存在
            const folderIds = new Map<string, string>([[root.path, rootItem.id]]);
            const keep = new Map<string, Set<string>>([[rootItem.id, new Set()]]);
            for (const e of entries) {
                const parentId = folderIds.get(e.parent);
                if (!parentId) continue;
                const childRef = `${root.id}:${e.path}`;
                keep.get(parentId)!.add(childRef);
                const item = ctx.upsert({
                    sourceRef: childRef,
                    kind: e.type === 'dir' ? 'category' : 'content',
                    type: e.type === 'dir' ? 'files.folder' : 'files.file',
                    title: e.name,
                    meta:
                        e.type === 'dir'
                            ? { path: e.path }
                            : { path: e.path, size: e.size, mtime: new Date(e.mtimeMs).toISOString() },
                    parentId,
                    position: e.type === 'dir' ? 0 : 1,
                });
                if (e.type === 'dir') {
                    folderIds.set(e.path, item.id);
                    keep.set(item.id, new Set());
                }
            }
            for (const [parentId, refs] of keep) ctx.removeMissing(parentId, refs);
        }
        // 撤销的授权目录:整棵子树软删除(ADR 0011 第 1 节)
        ctx.removeMissing(top.id, keepRoots);
    },
    async open(item: Item, ctx: OpenContext): Promise<ItemContent> {
        if (item.type !== 'files.file' || !item.sourceRef) {
            return textContent(item.summary ?? item.title);
        }
        const { text, truncated } = await readAuthorizedFile(pathOfRef(item.sourceRef), ctx.roots);
        const content = textContent(text, MAX_CONTENT_CHARS);
        return { ...content, truncated: content.truncated || truncated };
    },
};
