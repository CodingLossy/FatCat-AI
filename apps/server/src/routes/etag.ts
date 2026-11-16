// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 弱 ETag 与条件请求(ADR 0029 第 2 节):由响应体内容的哈希得出,不依赖新数据库列。
import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/** If-None-Match 是否命中(弱比较;支持逗号分隔的列表与 *)。 */
export function etagMatches(header: string | undefined, etag: string): boolean {
    if (!header) return false;
    const weak = (v: string) => v.trim().replace(/^W\//, '');
    return header.split(',').some((candidate) => candidate.trim() === '*' || weak(candidate) === weak(etag));
}

/**
 * 只处理 GET 的 200 JSON 响应:加 ETag;请求带匹配的 If-None-Match 时改为 304 且没有响应体。
 * 没有 If-None-Match 的请求,响应体与加这个中间件之前逐字相同。
 * `applies` 收到去掉 /api/v1 之前缀后的路径(从 /items 开始)。
 */
export function weakEtag(applies: (path: string) => boolean): MiddlewareHandler {
    return async (c, next) => {
        await next();
        if (c.req.method !== 'GET' || c.res.status !== 200) return;
        const path = c.req.path.slice(c.req.path.indexOf('/items'));
        if (!applies(path)) return;
        if (!c.res.headers.get('content-type')?.includes('json')) return;
        const body = await c.res.clone().text();
        const etag = `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
        if (etagMatches(c.req.header('if-none-match'), etag)) {
            c.res = new Response(null, { status: 304, headers: { ETag: etag } });
            return;
        }
        c.res.headers.set('ETag', etag);
    };
}
