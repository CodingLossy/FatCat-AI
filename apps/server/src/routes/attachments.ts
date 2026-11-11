// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 图片附件的上传与读取(ADR 0020 第 4 节)。类型按魔数判断,不信任文件名与 Content-Type。
import { createHash } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { Attachment, Id, MAX_ATTACHMENT_BYTES, sanitizeFileName, sniffImageType } from '@fatcat-ai/shared';
import { newId, type Repositories } from '@fatcat-ai/storage';
import { requireOwner } from '../auth/middleware.js';
import type { AttachmentFiles } from '../attachment-files.js';
import { ApiError, notFound } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

export interface AttachmentRouteDeps {
    repos: Repositories;
    files: AttachmentFiles;
}

/** multipart 表单在图片之外的开销上限;整个请求体由 app.ts 的 bodyLimit 卡住。 */
export const UPLOAD_OVERHEAD_BYTES = 64 * 1024;

const UploadForm = z.object({
    file: z
        .custom<File>((v) => v instanceof File, { message: 'file is required' })
        .openapi({ type: 'string', format: 'binary', description: 'PNG, JPEG, WebP or GIF, at most 5 MiB' }),
});

const uploadRoute = createRoute({
    method: 'post',
    path: '/attachments',
    tags: ['attachments'],
    summary: 'Upload an image to attach to a message',
    request: { body: { content: { 'multipart/form-data': { schema: UploadForm } }, required: true } },
    responses: {
        201: json(Attachment, 'Uploaded; not yet attached to a message'),
        400: problem('No file in the form'),
        413: problem('The image is larger than 5 MiB'),
        415: problem('Not a PNG, JPEG, WebP or GIF image'),
        ...authErrors,
    },
});

const getRoute = createRoute({
    method: 'get',
    path: '/attachments/{id}',
    tags: ['attachments'],
    summary: 'Read an image attachment (owner only)',
    request: { params: z.object({ id: Id }) },
    responses: {
        200: {
            content: { 'image/*': { schema: z.string().openapi({ type: 'string', format: 'binary' }) } },
            description: 'The image bytes',
        },
        404: problem('Not found'),
        ...authErrors,
    },
});

const tooLarge = () => new ApiError(413, 'payload_too_large', 'Payload Too Large', 'Images must be at most 5 MiB.');

export function attachmentRoutes(deps: AttachmentRouteDeps) {
    const { repos, files } = deps;
    return router()
        .openapi(uploadRoute, async (c) => {
            const ownerId = requireOwner(c);
            const { file } = c.req.valid('form');
            if (file.size > MAX_ATTACHMENT_BYTES) throw tooLarge();
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (bytes.length > MAX_ATTACHMENT_BYTES) throw tooLarge();
            const mediaType = sniffImageType(bytes);
            if (!mediaType) {
                throw new ApiError(
                    415,
                    'unsupported_media_type',
                    'Unsupported Media Type',
                    'Only PNG, JPEG, WebP and GIF images are accepted.',
                );
            }
            const id = newId();
            await files.write(id, bytes);
            try {
                const attachment = repos.attachments.create(
                    ownerId,
                    {
                        mediaType,
                        bytes: bytes.length,
                        sha256: createHash('sha256').update(bytes).digest('hex'),
                        fileName: sanitizeFileName(file.name, mediaType),
                    },
                    id,
                );
                return c.json(attachment, 201);
            } catch (error) {
                await files.remove(id);
                throw error;
            }
        })
        .openapi(getRoute, async (c) => {
            const ownerId = requireOwner(c);
            const attachment = repos.attachments.get(ownerId, c.req.valid('param').id);
            const bytes = attachment ? await files.read(attachment.id) : null;
            if (!attachment || !bytes) throw notFound('Attachment');
            return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
                'Content-Type': attachment.mediaType,
                'Content-Length': String(bytes.length),
                'Content-Disposition': 'inline',
                'Cache-Control': 'private, max-age=31536000, immutable',
                'X-Content-Type-Options': 'nosniff',
            });
        });
}
