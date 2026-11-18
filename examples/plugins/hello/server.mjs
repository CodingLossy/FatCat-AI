// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 示例插件(ADR 0040):用 SDK 注册工具、读设置、经主程序代发网络请求、提供知识地图条目。
// 它也是一个普通的 MCP stdio 服务器,不需要主程序的扩展方法就能被任何 MCP 客户端连接。
// 发布到市场前需要把它和依赖打成一个 JS 文件(见 README.md);这里直接引用工作区里的 SDK。
import { definePlugin } from '@fatcat-ai/plugin-sdk';

const plugin = definePlugin({ name: 'hello', version: '0.2.0' });

// 设置(plugin.json 的 settings)由主程序在启动时传入;改了设置后主程序会重启插件
const greeting = (ctx) => String(ctx.settings.greeting ?? 'Hello');

plugin.registerTool({
    name: 'hello',
    description: 'Greet someone by name.',
    inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Who to greet' } },
        required: ['name'],
    },
    handler: (args, ctx) => {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (!name) throw new Error('name is required');
        const text = `${greeting(ctx)}, ${name}!`;
        return ctx.settings.shout === true ? text.toUpperCase() : text;
    },
});

// 经主程序代发的请求:只能访问 plugin.json 里 net 声明的域名,并受主程序的 SSRF 防护约束
plugin.registerTool({
    name: 'fetch_title',
    description: 'Fetch https://example.com/ (or a page on it) and return its <title>.',
    inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'An https://example.com/ URL' } },
        required: ['url'],
    },
    handler: async (args, ctx) => {
        const response = await ctx.fetch(String(args.url ?? 'https://example.com/'));
        const title = /<title[^>]*>([^<]*)<\/title>/i.exec(response.text())?.[1]?.trim();
        return title ?? `no title (HTTP ${response.status})`;
    },
});

// 知识地图:「示例笔记」类别下的几条笔记。主程序同步时调用 roots / children,打开时调用 open
const NOTES = [
    { id: 'welcome', title: 'Welcome', body: 'This note comes from the hello example plugin.' },
    { id: 'tips', title: 'Tips', body: 'Plugins can add their own categories to the knowledge map.' },
];
plugin.registerItemProvider({
    type: 'note',
    roots: () => NOTES.map((n) => ({ id: n.id, type: 'note', title: n.title })),
    open: (id) => {
        const note = NOTES.find((n) => n.id === id);
        if (!note) throw new Error('no such note');
        return { title: note.title, content: note.body };
    },
});

await plugin.run();
