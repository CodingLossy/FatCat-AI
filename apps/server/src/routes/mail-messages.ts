// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 邮件缓存、草稿、附件入库与「问 AI」的 REST(ADR 0016,M3 PR 4;Web 的邮件页使用)。
// 邮件内容是不可信数据:接口只原样返回纯文本,客户端须按纯文本显示。都不会改动服务器上的邮件。
import { createRoute, z } from '@hono/zod-openapi';
import {
    Id,
    MailAskResult,
    MailAttachmentKbResult,
    MailDraft,
    MailDraftPatch,
    MailMessage,
    MailMessageQuery,
} from '@ai-personal/shared';
import { addAttachmentToKb, AttachmentError, type AttachmentKbDeps } from '@ai-personal/mail';
import type { MailMessageRecord, Repositories } from '@ai-personal/storage';
import { requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

const tags = ['mail'];
const idParam = z.object({ id: Id });

const listRoute = createRoute({
    method: 'get',
    path: '/mail/messages',
    tags,
    summary: 'List cached e-mails, newest first (no bodies); page with before = the last date',
    request: { query: MailMessageQuery },
    responses: { 200: json(z.object({ items: z.array(MailMessage) }), 'Messages'), ...authErrors },
});
const getRoute = createRoute({
    method: 'get',
    path: '/mail/messages/{id}',
    tags,
    summary: 'One cached e-mail with its plain-text body (untrusted content: show as plain text)',
    request: { params: idParam },
    responses: { 200: json(MailMessage, 'Message'), 404: problem('Not found'), ...authErrors },
});
const askRoute = createRoute({
    method: 'post',
    path: '/mail/messages/{id}/ask',
    tags,
    summary: 'Start a session about this e-mail; the session counts as having read untrusted content',
    request: { params: idParam },
    responses: { 201: json(MailAskResult, 'Session created'), 404: problem('Not found'), ...authErrors },
});
const attachmentKbRoute = createRoute({
    method: 'post',
    path: '/mail/attachments/{id}/knowledge-base',
    tags,
    summary: 'Download an attachment and add it to the knowledge base (only the chunks are kept)',
    request: { params: idParam },
    responses: {
        200: json(MailAttachmentKbResult, 'Added'),
        400: problem('Unsupported or too large'),
        404: problem('Not found'),
        ...authErrors,
    },
});
const draftsRoute = createRoute({
    method: 'get',
    path: '/mail/drafts',
    tags,
    summary: 'Local drafts, newest first',
    responses: { 200: json(z.object({ items: z.array(MailDraft) }), 'Drafts'), ...authErrors },
});
const draftGetRoute = createRoute({
    method: 'get',
    path: '/mail/drafts/{id}',
    tags,
    summary: 'One local draft',
    request: { params: idParam },
    responses: { 200: json(MailDraft, 'Draft'), 404: problem('Not found'), ...authErrors },
});
const draftPatchRoute = createRoute({
    method: 'patch',
    path: '/mail/drafts/{id}',
    tags,
    summary: 'Edit a draft; a pending send approval for it is no longer honored',
    request: { params: idParam, body: { content: { 'application/json': { schema: MailDraftPatch } }, required: true } },
    responses: {
        200: json(MailDraft, 'Updated'),
        400: problem('Invalid request'),
        404: problem('Not found'),
        ...authErrors,
    },
});
const draftDeleteRoute = createRoute({
    method: 'delete',
    path: '/mail/drafts/{id}',
    tags,
    summary: 'Delete a local draft',
    request: { params: idParam },
    responses: { 204: { description: 'Deleted' }, 404: problem('Not found'), ...authErrors },
});

/** 响应里不带服务器内部的文件夹路径。 */
function view(m: MailMessageRecord): MailMessage {
    const out: Partial<MailMessageRecord> = { ...m };
    delete out.folderPath;
    delete out.replyTo;
    return out as MailMessage;
}

export function mailMessageRoutes(deps: { repos: Repositories; attachments: Omit<AttachmentKbDeps, 'repos'> }) {
    const { repos } = deps;
    return router()
        .openapi(listRoute, (c) => {
            const q = MailMessageQuery.parse(c.req.valid('query'));
            const items = repos.mailCache.list(requireOwner(c), q).map(view);
            return c.json({ items }, 200);
        })
        .openapi(getRoute, (c) => {
            const m = repos.mailCache.get(requireOwner(c), c.req.valid('param').id);
            if (!m) throw notFound('Mail message');
            return c.json(view(m), 200);
        })
        .openapi(askRoute, (c) => {
            const ownerId = requireOwner(c);
            const m = repos.mailCache.get(ownerId, c.req.valid('param').id);
            if (!m) throw notFound('Mail message');
            // 会话从一开始就视为读过不可信内容;建议的第一句话只含邮件 id,不含邮件里的文字
            const session = repos.sessions.create(ownerId, { title: '关于一封邮件', untrusted: true });
            return c.json({ sessionId: session.id, prompt: `请先用 mail.read 读取邮件 ${m.id},然后:` }, 201);
        })
        .openapi(attachmentKbRoute, async (c) => {
            const ownerId = requireOwner(c);
            try {
                return c.json(
                    await addAttachmentToKb({ repos, ...deps.attachments }, ownerId, c.req.valid('param').id),
                    200,
                );
            } catch (error) {
                if (error instanceof AttachmentError) {
                    if (error.status === 404) throw notFound('Attachment');
                    throw new ApiError(400, 'validation_failed', 'Bad Request', error.message);
                }
                throw new ApiError(400, 'validation_failed', 'Bad Request', (error as Error).message.slice(0, 300));
            }
        })
        .openapi(draftsRoute, (c) => c.json({ items: repos.mailCache.drafts(requireOwner(c)) }, 200))
        .openapi(draftGetRoute, (c) => {
            const d = repos.mailCache.getDraft(requireOwner(c), c.req.valid('param').id);
            if (!d) throw notFound('Draft');
            return c.json(d, 200);
        })
        .openapi(draftPatchRoute, (c) => {
            const d = repos.mailCache.updateDraft(requireOwner(c), c.req.valid('param').id, c.req.valid('json'));
            if (!d) throw notFound('Draft');
            return c.json(d, 200);
        })
        .openapi(draftDeleteRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            if (!repos.mailCache.getDraft(ownerId, id)) throw notFound('Draft');
            repos.mailCache.deleteDraft(id);
            return c.body(null, 204);
        });
}
