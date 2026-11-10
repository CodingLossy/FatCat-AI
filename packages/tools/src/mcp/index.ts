// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// MCP 客户端的独立入口(@ai-personal/tools/mcp):只在配置了 MCP 服务器时才动态导入(ADR 0013 第 4 节)。
export {
    childEnv,
    MCP_PROTOCOL_VERSION,
    type McpCallResult,
    McpError,
    type McpToolInfo,
    StdioMcpClient,
    type StdioServerConfig,
} from './client.js';
export {
    MAX_RESULT_CHARS,
    McpManager,
    type McpManagerOptions,
    type OwnedMcpServer,
    resultText,
    toolSegment,
} from './manager.js';
