// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 图片附件的文件(ADR 0020 第 3 节):数据目录 attachments/<ownerId>/ 下以附件 id 命名(ADR 0053 第 5 节),
// 没有扩展名,从不使用用户给的文件名。2.0 以前的文件直接放在 attachments/ 下,启动时按数据库行搬到账户子目录
// (migrateAttachmentLayout);没搬完时读取会回落到旧位置。
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Repositories } from '@fatcat-ai/storage';

/** 附件 id 和账户 id 都是 ULID;任何别的名字都不拼进路径。 */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** 搬迁完成的标记文件:存在时不再检查旧位置。 */
export const LAYOUT_MARKER = '.layout-v2';

export interface AttachmentFile {
    /** 旧布局(直接放在 attachments/ 下)的文件为 null。 */
    ownerId: string | null;
    id: string;
    mtimeMs: number;
}

export interface AttachmentFiles {
    write(ownerId: string, id: string, bytes: Uint8Array): Promise<void>;
    /** 文件不存在时返回 null。 */
    read(ownerId: string, id: string): Promise<Uint8Array | null>;
    /** 不存在时不报错;ownerId 为 null 时只删旧布局里的文件。 */
    remove(ownerId: string | null, id: string): Promise<void>;
    /** 目录里的附件文件与修改时间(清理孤立文件用),包括旧布局里的文件。 */
    list(): Promise<AttachmentFile[]>;
}

function checked(name: string, what: string): string {
    if (!ULID.test(name)) throw new Error(`invalid ${what} id`);
    return name;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function names(dir: string): Promise<string[]> {
    try {
        return await readdir(dir);
    } catch (error) {
        if (isMissing(error)) return [];
        throw error;
    }
}

export function createAttachmentFiles(dataDir: string): AttachmentFiles {
    const dir = join(dataDir, 'attachments');
    const ownerDir = (ownerId: string) => join(dir, checked(ownerId, 'account'));
    const path = (ownerId: string, id: string) => join(ownerDir(ownerId), checked(id, 'attachment'));
    const legacy = (id: string) => join(dir, checked(id, 'attachment'));
    return {
        async write(ownerId, id, bytes) {
            await mkdir(ownerDir(ownerId), { recursive: true, mode: 0o700 });
            // wx:同名文件已存在时失败,不覆盖
            const handle = await open(path(ownerId, id), 'wx', 0o600);
            try {
                await handle.writeFile(bytes);
            } finally {
                await handle.close();
            }
        },
        async read(ownerId, id) {
            for (const file of [path(ownerId, id), legacy(id)]) {
                try {
                    return await readFile(file);
                } catch (error) {
                    if (!isMissing(error)) throw error;
                }
            }
            return null;
        },
        async remove(ownerId, id) {
            if (ownerId !== null) await rm(path(ownerId, id), { force: true });
            await rm(legacy(id), { force: true });
        },
        async list() {
            const out: AttachmentFile[] = [];
            for (const name of await names(dir)) {
                if (!ULID.test(name)) continue;
                const info = await stat(join(dir, name)).catch(() => null);
                if (info?.isFile()) out.push({ ownerId: null, id: name, mtimeMs: info.mtimeMs });
                if (!info?.isDirectory()) continue;
                for (const id of await names(join(dir, name))) {
                    if (!ULID.test(id)) continue;
                    const file = await stat(join(dir, name, id)).catch(() => null);
                    if (file?.isFile()) out.push({ ownerId: name, id, mtimeMs: file.mtimeMs });
                }
            }
            return out;
        },
    };
}

export interface LayoutMigration {
    /** 这次搬到账户子目录的文件数。 */
    moved: number;
    /** 数据库里有行、但哪里都找不到文件的附件数(以前就丢了,读取时显示占位)。 */
    missing: number;
    /** 已经完成过(有标记文件),这次什么都没做。 */
    alreadyDone: boolean;
}

/**
 * 附件目录按账户分子目录(ADR 0053 第 10 节):启动时按数据库行把 attachments/<id> 复制到
 * attachments/<ownerId>/<id>(先写 .part 再改名);全部复制完才写标记文件,然后才删除旧文件。
 * 中途失败(磁盘满、断电)时旧文件都还在,下次启动从头再检查一遍,已经复制好的跳过。
 */
export async function migrateAttachmentLayout(dataDir: string, repos: Repositories): Promise<LayoutMigration> {
    const dir = join(dataDir, 'attachments');
    if ((await names(dir)).includes(LAYOUT_MARKER)) return { moved: 0, missing: 0, alreadyDone: true };
    const rows = repos.attachments.allOwned();
    let moved = 0;
    let missing = 0;
    const copied: string[] = [];
    for (const { id, ownerId } of rows) {
        if (!ULID.test(id) || !ULID.test(ownerId)) continue;
        const from = join(dir, id);
        const to = join(dir, ownerId, id);
        const target = await stat(to).catch(() => null);
        const source = await stat(from).catch(() => null);
        if (target?.isFile()) {
            if (source?.isFile()) copied.push(from);
            continue;
        }
        if (!source?.isFile()) {
            missing++;
            continue;
        }
        await mkdir(join(dir, ownerId), { recursive: true, mode: 0o700 });
        const part = `${to}.part`;
        await copyFile(from, part);
        await rename(part, to);
        copied.push(from);
        moved++;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // wx:不覆盖已有的标记(服务器锁保证同一时间只有一个进程在搬)
    await writeFile(join(dir, LAYOUT_MARKER), `${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' }).catch(
        (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        },
    );
    // 全部复制完、标记已写:这时才删旧文件。没有数据库行的旧文件留给每天的清理(超过宽限期才删)
    for (const file of copied) await rm(file, { force: true });
    return { moved, missing, alreadyDone: false };
}

/** 内存中的实现:只给测试与导出 OpenAPI 文档用。 */
export function createMemoryAttachmentFiles(now: () => number = Date.now): AttachmentFiles {
    const files = new Map<string, { ownerId: string; id: string; bytes: Uint8Array; mtimeMs: number }>();
    const key = (ownerId: string, id: string) => `${checked(ownerId, 'account')}/${checked(id, 'attachment')}`;
    return {
        write(ownerId, id, bytes) {
            if (files.has(key(ownerId, id))) return Promise.reject(new Error('attachment file exists'));
            files.set(key(ownerId, id), { ownerId, id, bytes: bytes.slice(), mtimeMs: now() });
            return Promise.resolve();
        },
        read: (ownerId, id) => Promise.resolve(files.get(key(ownerId, id))?.bytes ?? null),
        remove(ownerId, id) {
            if (ownerId !== null) files.delete(key(ownerId, id));
            return Promise.resolve();
        },
        list: () => Promise.resolve([...files.values()].map(({ ownerId, id, mtimeMs }) => ({ ownerId, id, mtimeMs }))),
    };
}

/** RunManager 的 loadImage:按 owner 读附件并转成 base64;行或文件不存在时返回 null(上下文里换成占位文本)。 */
export function createImageLoader(repos: Repositories, files: AttachmentFiles) {
    return async (ownerId: string, attachmentId: string) => {
        const attachment = repos.attachments.get(ownerId, attachmentId);
        const bytes = attachment ? await files.read(ownerId, attachment.id) : null;
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
    for (const { id, ownerId } of stale) await files.remove(ownerId, id);
    let orphans = 0;
    for (const file of await files.list()) {
        if (now.getTime() - file.mtimeMs < ORPHAN_GRACE_MS) continue;
        // 账户子目录里的文件要行和账户都对得上;旧布局里的文件只看有没有行(还没搬完)
        const row =
            file.ownerId === null ? repos.attachments.exists(file.id) : repos.attachments.get(file.ownerId, file.id);
        if (row) continue;
        await files.remove(file.ownerId, file.id);
        orphans++;
    }
    return stale.length + orphans;
}
