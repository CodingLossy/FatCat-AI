// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// IM 渠道的 REST(ADR 0022 第 11 节):都需要登录并按 ownerId 取数据,别人的渠道一律 404。
// 响应里不含任何密钥或密钥引用;外部账号只返回打码后的形式。
import { createRoute, z } from '@hono/zod-openapi';
import {
    Channel,
    ChannelCreate,
    ChannelPairing,
    ChannelPatch,
    ChannelStatus,
    Id,
    pageOf,
    WechatLoginStart,
    WechatLoginState,
} from '@fatcat-ai/shared';
import type { Repositories } from '@fatcat-ai/storage';
import { requireOwner } from '../auth/middleware.js';
import type { ChannelHub } from '../channels/hub.js';
import { toChannel } from '../channels/hub.js';
import type { WechatChannels } from '../channels/wechat.js';
import { ApiError, notFound } from '../errors.js';
import { authErrors, json, problem, router } from './common.js';

const tags = ['channels'];
const idParam = z.object({ id: Id });

const listRoute = createRoute({
    method: 'get',
    path: '/channels',
    tags,
    summary: 'List IM channels (not paginated: a server has only a few)',
    responses: { 200: json(pageOf(Channel), 'Channels'), ...authErrors },
});
const createChannelRoute = createRoute({
    method: 'post',
    path: '/channels',
    tags,
    summary: 'Add an IM channel; new channels are disabled until enabled',
    request: { body: { content: { 'application/json': { schema: ChannelCreate } }, required: true } },
    responses: { 201: json(Channel, 'Created'), 400: problem('Invalid request'), ...authErrors },
});
const getRoute = createRoute({
    method: 'get',
    path: '/channels/{id}',
    tags,
    summary: 'Get an IM channel',
    request: { params: idParam },
    responses: { 200: json(Channel, 'Channel'), 404: problem('Not found'), ...authErrors },
});
const patchRoute = createRoute({
    method: 'patch',
    path: '/channels/{id}',
    tags,
    summary: 'Rename, enable or disable a channel, or switch the degraded-recall notice',
    request: { params: idParam, body: { content: { 'application/json': { schema: ChannelPatch } }, required: true } },
    responses: {
        200: json(Channel, 'Updated'),
        400: problem('Invalid request'),
        404: problem('Not found'),
        ...authErrors,
    },
});
const deleteRoute = createRoute({
    method: 'delete',
    path: '/channels/{id}',
    tags,
    summary: 'Stop and delete a channel (its session stays)',
    request: { params: idParam },
    responses: { 204: { description: 'Deleted' }, 404: problem('Not found'), ...authErrors },
});
const pairingRoute = createRoute({
    method: 'post',
    path: '/channels/{id}/pairing',
    tags,
    summary: 'Create a one-time 6-digit pairing code (10 minutes); the plain code appears only in this response',
    request: { params: idParam },
    responses: {
        201: json(ChannelPairing, 'Pairing code'),
        404: problem('Not found'),
        409: problem('The channel already has an owner account; unbind it first'),
        ...authErrors,
    },
});
const unbindRoute = createRoute({
    method: 'delete',
    path: '/channels/{id}/binding',
    tags,
    summary: 'Unbind the owner account; later messages from it are ignored',
    request: { params: idParam },
    responses: { 204: { description: 'Unbound' }, 404: problem('Not found'), ...authErrors },
});
const statusRoute = createRoute({
    method: 'get',
    path: '/channels/{id}/status',
    tags,
    summary: 'Run state, last error and counters since the server started',
    request: { params: idParam },
    responses: { 200: json(ChannelStatus, 'Status'), 404: problem('Not found'), ...authErrors },
});

const wechatLoginRoute = createRoute({
    method: 'post',
    path: '/channels/{id}/wechat/login',
    tags,
    summary: 'Start WeChat QR-code login; render qrContent as a QR code and poll the GET route',
    request: { params: idParam },
    responses: {
        201: json(WechatLoginStart, 'QR code to scan'),
        404: problem('Not found'),
        409: problem('Not a WeChat channel'),
        502: problem('The WeChat service did not return a QR code'),
        ...authErrors,
    },
});
const wechatLoginStateRoute = createRoute({
    method: 'get',
    path: '/channels/{id}/wechat/login',
    tags,
    summary: 'Scan state of the current WeChat login; after confirmed the token is in secrets.yaml',
    request: { params: idParam },
    responses: {
        200: json(WechatLoginState, 'Login state'),
        404: problem('Not found, or no login was started'),
        409: problem('Not a WeChat channel'),
        ...authErrors,
    },
});

export function channelRoutes(deps: { repos: Repositories; hub: ChannelHub; wechat: WechatChannels }) {
    const { repos, hub, wechat } = deps;
    const channelOr404 = (ownerId: string, id: string) => {
        const channel = repos.channels.get(ownerId, id);
        if (!channel) throw notFound('Channel');
        return channel;
    };
    const wechatOr409 = (ownerId: string, id: string) => {
        const channel = channelOr404(ownerId, id);
        if (channel.kind !== 'wechat') {
            throw new ApiError(409, 'conflict', 'Conflict', 'This channel does not use WeChat login.');
        }
        return channel;
    };

    return router()
        .openapi(listRoute, (c) =>
            c.json({ items: repos.channels.list(requireOwner(c)).map(toChannel), nextCursor: null }, 200),
        )
        .openapi(createChannelRoute, (c) => {
            const body = c.req.valid('json');
            return c.json(toChannel(repos.channels.create(requireOwner(c), body)), 201);
        })
        .openapi(getRoute, (c) => c.json(toChannel(channelOr404(requireOwner(c), c.req.valid('param').id)), 200))
        .openapi(patchRoute, async (c) => {
            const ownerId = requireOwner(c);
            const { id } = c.req.valid('param');
            channelOr404(ownerId, id);
            const updated = repos.channels.update(ownerId, id, c.req.valid('json'))!;
            await hub.apply(updated);
            return c.json(toChannel(updated), 200);
        })
        .openapi(deleteRoute, async (c) => {
            const ownerId = requireOwner(c);
            const channel = channelOr404(ownerId, c.req.valid('param').id);
            await hub.remove(channel.id);
            if (channel.kind === 'wechat') wechat.forget(channel.id);
            repos.channels.delete(ownerId, channel.id);
            return c.body(null, 204);
        })
        .openapi(pairingRoute, (c) => {
            const channel = channelOr404(requireOwner(c), c.req.valid('param').id);
            if (channel.binding) {
                throw new ApiError(409, 'conflict', 'Conflict', 'The channel already has an owner account.');
            }
            return c.json(hub.createPairing(channel), 201);
        })
        .openapi(unbindRoute, (c) => {
            const channel = channelOr404(requireOwner(c), c.req.valid('param').id);
            repos.channels.unbind(channel.id);
            hub.unbound(channel.id);
            return c.body(null, 204);
        })
        .openapi(statusRoute, (c) => c.json(hub.status(channelOr404(requireOwner(c), c.req.valid('param').id)), 200))
        .openapi(wechatLoginRoute, async (c) => {
            const channel = wechatOr409(requireOwner(c), c.req.valid('param').id);
            return c.json(await wechat.startLogin(channel), 201);
        })
        .openapi(wechatLoginStateRoute, (c) => {
            const channel = wechatOr409(requireOwner(c), c.req.valid('param').id);
            const state = wechat.loginState(channel.id);
            if (!state) throw notFound('WeChat login');
            return c.json(state, 200);
        });
}
