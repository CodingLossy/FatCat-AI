// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, withDocApp } from './openapi.js';

// 冻结 /api/v1 前的覆盖检查(M5c PR 2):路由表与 OpenAPI 文档必须一一对应,
// 这样 CI 里的 oasdiff 比较才覆盖 /api/v1 的全部「方法 + 路径」。
// 有意不进文档的路径只能写在这里,并写明原因。
const EXCLUDED: Record<string, string> = {
    'GET /api/v1/openapi.json': '文档自身,需要鉴权;静态副本是 apps/server/openapi/v1.json',
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Hono 的 `:id` 写成 OpenAPI 的 `{id}`;去掉可选参数的问号与自定义正则。 */
function toOpenApiPath(path: string): string {
    return path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g, '{$1}');
}

async function routeKeys(): Promise<string[]> {
    return withDocApp((app) => {
        const keys = new Set<string>();
        for (const r of app.routes) {
            // 'ALL' 是中间件(鉴权、限长、404 兜底),不是接口
            if (r.method === 'ALL' || !r.path.startsWith('/api/v1/')) continue;
            keys.add(`${r.method} ${toOpenApiPath(r.path)}`);
        }
        return [...keys].sort();
    });
}

async function docKeys(): Promise<string[]> {
    const doc = (await buildOpenApiDocument()) as { paths: Record<string, Record<string, unknown>> };
    const keys: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
        for (const m of Object.keys(item)) {
            if (METHODS.includes(m)) keys.push(`${m.toUpperCase()} ${path}`);
        }
    }
    return keys.sort();
}

describe('OpenAPI 覆盖 /api/v1 的全部路由', () => {
    it('路由表里每个 /api/v1 接口都在文档中(除白名单)', async () => {
        const routes = await routeKeys();
        const docs = new Set(await docKeys());
        expect(routes.length).toBeGreaterThan(50);
        const missing = routes.filter((k) => !docs.has(k) && !(k in EXCLUDED));
        expect(missing).toEqual([]);
    });

    it('文档里每个操作都有对应路由', async () => {
        const routes = new Set(await routeKeys());
        const orphans = (await docKeys()).filter((k) => !routes.has(k));
        expect(orphans).toEqual([]);
    });

    it('白名单里的条目确实存在路由且不在文档中(过期条目要删掉)', async () => {
        const routes = new Set(await routeKeys());
        const docs = new Set(await docKeys());
        for (const k of Object.keys(EXCLUDED)) {
            expect(routes.has(k), `${k} has no route`).toBe(true);
            expect(docs.has(k), `${k} is documented; drop it from EXCLUDED`).toBe(false);
        }
    });
});
