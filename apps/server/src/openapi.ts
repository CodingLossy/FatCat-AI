// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 生成 OpenAPI 文档的静态副本(业主决定:/api/v1/openapi.json 需要鉴权,CI 另导出静态文件)。
import { EventBus, RunManager } from '@ai-personal/agent';
import { createItemService } from '@ai-personal/items';
import { Redactor, SecretStore } from '@ai-personal/providers';
import { createRepositories, migrate, migrations, openDatabase } from '@ai-personal/storage';
import { createApp } from './app.js';
import { createLogger } from './log.js';
import { createMemoryStack } from './memory-setup.js';
import { SERVER_VERSION } from './version.js';

/** 用内存数据库组装一个应用实例,只为读取路由定义;不发任何网络请求。 */
export async function buildOpenApiDocument(): Promise<unknown> {
    const conn = openDatabase(':memory:');
    try {
        await migrate(conn.sqlite, migrations);
        const repos = createRepositories(conn);
        const redactor = new Redactor();
        const secrets = new SecretStore({ dataDir: '.', redactor, env: {} });
        const bus = new EventBus();
        const app = createApp({
            config: { sourceUrl: '', webDir: null, cookieSecure: 'auto', setupCode: null },
            repos,
            logger: createLogger({ level: 'error' }),
            secrets,
            providerDeps: { secrets, redactor },
            bus,
            memory: createMemoryStack(repos, { enqueue: () => undefined, search: () => Promise.resolve(null) }),
            items: createItemService({ repos }),
            runs: new RunManager({
                repos,
                bus,
                providerFor: () => {
                    throw new Error('not used');
                },
            }),
        });
        return app.getOpenAPI31Document({
            openapi: '3.1.0',
            info: { title: 'AI-Personal API', version: SERVER_VERSION, license: { name: 'AGPL-3.0-only' } },
            security: [{ bearer: [] }, { session: [] }],
        });
    } finally {
        conn.close();
    }
}
