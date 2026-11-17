// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 最小的示例插件(ADR 0040):用 SDK 注册一个只读工具。它也是一个普通的 MCP stdio 服务器,
// 不需要主程序的扩展方法就能被任何 MCP 客户端连接。
// 发布到市场前需要把它和依赖打成一个 JS 文件(见 README.md);这里直接引用工作区里的 SDK。
import { definePlugin } from '@fatcat-ai/plugin-sdk';

const plugin = definePlugin({ name: 'hello', version: '0.1.0' });

plugin.registerTool({
    name: 'hello',
    description: 'Greet someone by name.',
    inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Who to greet' } },
        required: ['name'],
    },
    handler: (args) => {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (!name) throw new Error('name is required');
        return `Hello, ${name}!`;
    },
});

await plugin.run();
