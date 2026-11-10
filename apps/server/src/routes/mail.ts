// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 邮件账户的 REST(ADR 0016 第 1 节):只有用户能增删改,没有对应的工具;密码只收引用,响应不含密码。
import { createRoute, z } from '@hono/zod-openapi';
import {
    Id,
    MailAccount,
    MailAccountInput,
    MailAccountPatch,
    MailConnectionTest,
    MailFolder,
    MailPreset,
    MailSyncResult,
    pageOf,
} from '@ai-personal/shared';
import { appendsToSent, MAIL_PRESETS } from '@ai-personal/mail';
import type { SecretStore } from '@ai-personal/providers';
import type { MailAccountRecord, Repositories } from '@ai-personal/storage';
import type { ItemService, KnowledgeBase } from '@ai-personal/items';
import { requireOwner } from '../auth/middleware.js';
import { notFound } from '../errors.js';
import type { MailService } from '../mail-setup.js';
import { authErrors, json, problem, router } from './common.js';

const tags = ['mail'];
const idParam = z.object({ id: Id });

const presetsRoute = createRoute({
    method: 'get',
    path: '/mail/presets',
    tags,
    summary: 'Default servers and app-password instructions for common providers (QQ Mail, 163, Gmail)',
    responses: { 200: json(z.object({ items: z.array(MailPreset) }), 'Presets'), ...authErrors },
});
const listRoute = createRoute({
    method: 'get',
    path: '/mail/accounts',
    tags,
    summary: 'List mail accounts (passwords are never returned, only their references)',
    responses: { 200: json(pageOf(MailAccount), 'Accounts'), ...authErrors },
});
const createAccountRoute = createRoute({
    method: 'post',
    path: '/mail/accounts',
    tags,
    summary: 'Add a mail account; the password must be an env: or file: reference',
    request: { body: { content: { 'application/json': { schema: MailAccountInput } }, required: true } },
    responses: {
        201: json(MailAccount, 'Added; it syncs within a minute'),
        400: problem('Invalid request'),
        ...authErrors,
    },
});
const getRoute = createRoute({
    method: 'get',
    path: '/mail/accounts/{id}',
    tags,
    summary: 'Get a mail account',
    request: { params: idParam },
    responses: { 200: json(MailAccount, 'Account'), 404: problem('Not found'), ...authErrors },
});
const patchRoute = createRoute({
    method: 'patch',
    path: '/mail/accounts/{id}',
    tags,
    summary: 'Change a mail account; the next sync runs within a minute',
    request: {
        params: idParam,
        body: { content: { 'application/json': { schema: MailAccountPatch } }, required: true },
    },
    responses: {
        200: json(MailAccount, 'Updated'),
        400: problem('Invalid request'),
        404: problem('Not found'),
        ...authErrors,
    },
});
const deleteRoute = createRoute({
    method: 'delete',
    path: '/mail/accounts/{id}',
    tags,
    summary: 'Remove a mail account and its local cache (nothing is changed on the mail server)',
    request: { params: idParam },
    responses: { 204: { description: 'Removed' }, 404: problem('Not found'), ...authErrors },
});
const foldersRoute = createRoute({
    method: 'get',
    path: '/mail/accounts/{id}/folders',
    tags,
    summary: 'Synced folders (Inbox and Sent) with message and unread counts',
    request: { params: idParam },
    responses: {
        200: json(z.object({ items: z.array(MailFolder) }), 'Folders'),
        404: problem('Not found'),
        ...authErrors,
    },
});
const testRoute = createRoute({
    method: 'post',
    path: '/mail/accounts/{id}/test',
    tags,
    summary: 'Test the IMAP and SMTP logins; no mail is sent',
    request: { params: idParam },
    responses: { 200: json(MailConnectionTest, 'Result'), 404: problem('Not found'), ...authErrors },
});
const syncRoute = createRoute({
    method: 'post',
    path: '/mail/accounts/{id}/sync',
    tags,
    summary: 'Sync an account now (read only; waits for an already running sync of the same account)',
    request: { params: idParam },
    responses: { 200: json(MailSyncResult, 'Result'), 404: problem('Not found'), ...authErrors },
});

export function mailRoutes(deps: {
    repos: Repositories;
    secrets: Pick<SecretStore, 'status'>;
    mail: MailService;
    /** 删除账户后清理条目与知识库(ADR 0016,M3 PR 4)。 */
    items?: Pick<ItemService, 'sync'>;
    kb?: Pick<KnowledgeBase, 'index'>;
}) {
    const { repos, secrets, mail } = deps;
    const view = (a: MailAccountRecord): MailAccount => ({
        ...a,
        appendToSent: appendsToSent(a),
        passwordStatus: secrets.status(a.passwordRef) === 'present' ? 'present' : 'missing',
    });
    const load = (ownerId: string, id: string) => {
        const account = repos.mail.get(ownerId, id);
        if (!account) throw notFound('Mail account');
        return account;
    };
    return router()
        .openapi(presetsRoute, (c) => c.json({ items: [...MAIL_PRESETS] }, 200))
        .openapi(listRoute, (c) => c.json({ items: repos.mail.list(requireOwner(c)).map(view), nextCursor: null }, 200))
        .openapi(createAccountRoute, (c) => {
            const ownerId = requireOwner(c);
            const body = MailAccountInput.parse(c.req.valid('json'));
            const account = repos.mail.create(ownerId, body);
            c.get('logger').info({ mailAccount: account.id }, 'mail account added');
            return c.json(view(account), 201);
        })
        .openapi(getRoute, (c) => c.json(view(load(requireOwner(c), c.req.valid('param').id)), 200))
        .openapi(patchRoute, (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            load(ownerId, id);
            return c.json(view(repos.mail.update(ownerId, id, c.req.valid('json'))!), 200);
        })
        .openapi(deleteRoute, async (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            if (!repos.mail.delete(ownerId, id)) throw notFound('Mail account');
            c.get('logger').info({ mailAccount: id }, 'mail account removed');
            // 条目随之软删除;知识库接着清理这些条目的分块与向量
            if (deps.items) {
                await deps.items.sync(ownerId);
                await deps.kb?.index(ownerId);
            }
            return c.body(null, 204);
        })
        .openapi(foldersRoute, (c) => {
            const { id } = c.req.valid('param');
            load(requireOwner(c), id);
            return c.json({ items: repos.mail.folders(id) }, 200);
        })
        .openapi(testRoute, async (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            load(ownerId, id);
            return c.json(await mail.test(ownerId, id), 200);
        })
        .openapi(syncRoute, async (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            load(ownerId, id);
            return c.json(await mail.sync(ownerId, id), 200);
        });
}
