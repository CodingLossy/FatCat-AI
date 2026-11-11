// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 图片附件的契约(ADR 0020)。M4 PR 2 只加入独立的 schema 与常量;
// 接入 ModelProfile、SendMessageRequest、Message.parts 与 ErrorCode 在 PR 3 与实现一起提交。
import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';
import { isRiff, matchesAt } from './magic.js';

export const ATTACHMENT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const AttachmentMediaType = z.enum(ATTACHMENT_MEDIA_TYPES);
export type AttachmentMediaType = z.infer<typeof AttachmentMediaType>;

/** 单张图片的上限(5 MiB)。 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** 每条消息最多的图片数。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_FILE_NAME_CHARS = 255;

const FileName = z.string().min(1).max(MAX_FILE_NAME_CHARS);

/** POST /api/v1/attachments 的响应(PR 3 起提供)。 */
export const Attachment = z.object({
    id: Id,
    /** 上传后尚未随消息发送时为 null;24 小时内未被引用的附件由维护任务删除。 */
    messageId: Id.nullable(),
    mediaType: AttachmentMediaType,
    bytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** 只作显示;存储用随机 id。 */
    fileName: FileName,
    createdAt: IsoDateTime,
});
export type Attachment = z.infer<typeof Attachment>;

/** Message.parts 中的图片(PR 3 起提供);图片字节经 GET /api/v1/attachments/{id} 读取。 */
export const ImageMessagePart = z.object({
    type: z.literal('image'),
    attachmentId: Id,
    mediaType: AttachmentMediaType,
    fileName: FileName,
});
export type ImageMessagePart = z.infer<typeof ImageMessagePart>;

/** SendMessageRequest.attachmentIds(PR 3 起提供):1–4 个,不能重复。 */
export const AttachmentIds = z
    .array(Id)
    .min(1)
    .max(MAX_ATTACHMENTS_PER_MESSAGE)
    .refine((ids) => new Set(ids).size === ids.length, 'attachment ids must be unique');
export type AttachmentIds = z.infer<typeof AttachmentIds>;

/** 按魔数判断图片类型;不信任文件名与 Content-Type(ADR 0020 第 2 节)。 */
export function sniffImageType(bytes: Uint8Array): AttachmentMediaType | null {
    if (matchesAt(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (matchesAt(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (matchesAt(bytes, [0x47, 0x49, 0x46, 0x38, null, 0x61]) && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
        return 'image/gif';
    }
    if (isRiff(bytes, 'WEBP')) return 'image/webp';
    return null;
}

const EXTENSIONS: Record<AttachmentMediaType, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

/** C0 / C1 控制字符与双向控制字符(后者可用 RLO 等把「gpj.exe」显示成「exe.jpg」)。 */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * 显示用文件名:去掉路径部分、控制字符与双向控制字符,截到 255 个字符;为空时用 image.<扩展名>。
 * 结果从不用于拼接存储路径。
 */
export function sanitizeFileName(name: string, mediaType: AttachmentMediaType): string {
    const base = name.split(/[/\\]/).pop() ?? '';
    const cleaned = base.replace(UNSAFE_CHARS, '').trim();
    const chars = [...cleaned].slice(0, MAX_FILE_NAME_CHARS).join('');
    return chars === '' || chars === '.' || chars === '..' ? `image.${EXTENSIONS[mediaType]}` : chars;
}
