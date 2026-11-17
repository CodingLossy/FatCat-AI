// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

export { definePlugin } from './plugin.js';
export type {
    ItemProvider,
    Plugin,
    PluginContext,
    PluginOptions,
    RunOptions,
    ToolDefinition,
    ToolResult,
} from './plugin.js';
export { PluginRpcError } from './rpc.js';
export { PLUGIN_RPC_ERRORS } from '@fatcat-ai/shared';
export type { PluginItemNode } from '@fatcat-ai/shared';
