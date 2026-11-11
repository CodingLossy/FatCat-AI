// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 图片附件的文件(ADR 0020 第 3 节):数据目录 attachments/ 下以附件 id 命名,没有扩展名,从不使用用户给的文件名。
import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Repositories } from '@fatcat-ai/storage';

/** 附件 id 是 ULID;任何别的名字都不拼进路径。 */
const ATTACHMENT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface AttachmentFiles {
    write(id: string, bytes: Uint8Array): Promise<void>;
    /** 文件不存在时返回 null。 */
    read(id: string): Promise<Uint8Array | null>;
    /** 不存在时不报错。 */
    remove(id: string): Promise<void>;
    /** 目录里的附件文件与修改时间(清理孤立文件用)。 */
    list(): Promise<{ id: string; mtimeMs: number }[]>;
}

function checkedId(id: string): string {
    if (!ATTACHMENT_ID.test(id)) throw new Error('invalid attachment id');
    return id;
}

export function createAttachmentFiles(dataDir: string): AttachmentFiles {
    const dir = join(dataDir, 'attachments');
    const path = (id: string) => join(dir, checkedId(id));
    return {
        async write(id, bytes) {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            // wx:同名文件已存在时失败,不覆盖
            const handle = await open(path(id), 'wx', 0o600);
            try {
                await handle.writeFile(bytes);
            } finally {
                await handle.close();
            }
        },
        async read(id) {
            try {
                return await readFile(path(id));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
        },
        async remove(id) {
            await rm(path(id), { force: true });
        },
        async list() {
            let names: string[];
            try {
                names = await readdir(dir);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
                throw error;
            }
            const out: { id: string; mtimeMs: number }[] = [];
            for (const name of names) {
                if (!ATTACHMENT_ID.test(name)) continue;
                const info = await stat(join(dir, name)).catch(() => null);
                if (info?.isFile()) out.push({ id: name, mtimeMs: info.mtimeMs });
            }
            return out;
        },
    };
}

/** 内存中的实现:只给测试与导出 OpenAPI 文档用。 */
export function createMemoryAttachmentFiles(now: () => number = Date.now): AttachmentFiles {
    const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
    return {
        write(id, bytes) {
            if (files.has(checkedId(id))) return Promise.reject(new Error('attachment file exists'));
            files.set(id, { bytes: bytes.slice(), mtimeMs: now() });
            return Promise.resolve();
        },
        read: (id) => Promise.resolve(files.get(checkedId(id))?.bytes ?? null),
        remove(id) {
            files.delete(checkedId(id));
            return Promise.resolve();
        },
        list: () => Promise.resolve([...files].map(([id, f]) => ({ id, mtimeMs: f.mtimeMs }))),
    };
}

/** RunManager 的 loadImage:按 owner 读附件并转成 base64;行或文件不存在时返回 null(上下文里换成占位文本)。 */
export function createImageLoader(repos: Repositories, files: AttachmentFiles) {
    return async (ownerId: string, attachmentId: string) => {
        const attachment = repos.attachments.get(ownerId, attachmentId);
        const bytes = attachment ? await files.read(attachment.id) : null;
        return attachment && bytes
            ? { mediaType: attachment.mediaType, data: Buffer.from(bytes).toString('base64') }
            : null;
    };
}

/** 未被消息引用的附件保留多久(ADR 0020 第 3 节)。 */
export const UNLINKED_TTL_MS = 24 * 60 * 60 * 1000;
/** 没有数据库行的文件至少存在这么久才删除,避免删掉正在上传的文件。 */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** 每天的清理:删除 24 小时内未被引用的附件,以及没有数据库行的孤立文件。返回删除的文件数。 */
export async function sweepAttachments(repos: Repositories, files: AttachmentFiles, now: Date): Promise<number> {
    const stale = repos.attachments.removeUnlinkedBefore(new Date(now.getTime() - UNLINKED_TTL_MS));
    for (const id of stale) await files.remove(id);
    let orphans = 0;
    for (const file of await files.list()) {
        if (now.getTime() - file.mtimeMs < ORPHAN_GRACE_MS || repos.attachments.exists(file.id)) continue;
        await files.remove(file.id);
        orphans++;
    }
    return stale.length + orphans;
}
