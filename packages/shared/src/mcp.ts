// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// MCP 服务器配置(ADR 0013):只能由用户经 API / UI 增删,模型不能修改。M2 只支持 stdio。
import { z } from 'zod';
import { Id, IsoDateTime } from './common.js';
import { isOwnEnvName } from './rename.js';
import { ToolRisk } from './tools.js';

const EnvName = z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
    .refine((name) => !isOwnEnvName(name), 'FATCAT_AI_* and AIP_* variables are never passed to MCP servers');

export const McpServerInput = z.strictObject({
    /** 用于工具名 mcp.<name>.<tool>。 */
    name: z.string().regex(/^[a-z0-9_-]{1,32}$/, 'lowercase letters, digits, "_" or "-" (at most 32)'),
    /** 可执行文件;不经过 shell。 */
    command: z.string().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(64).default([]),
    cwd: z.string().min(1).max(4096).optional(),
    /** 允许传给子进程的环境变量名字;值从服务器进程自己的环境中读取,从不保存。 */
    envPassthrough: z.array(EnvName).max(32).default([]),
    enabled: z.boolean().default(true),
    /** 按工具覆盖风险级别;默认一律为 write(ADR 0013 第 3 节)。 */
    toolRisks: z.record(z.string().max(64), ToolRisk).default({}),
});
export type McpServerInput = z.input<typeof McpServerInput>;

export const McpServerPatch = z.strictObject({
    enabled: z.boolean().optional(),
    toolRisks: z.record(z.string().max(64), ToolRisk).optional(),
});
export type McpServerPatch = z.infer<typeof McpServerPatch>;

export const McpServer = z.object({
    id: Id,
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    cwd: z.string().nullable(),
    envPassthrough: z.array(z.string()),
    enabled: z.boolean(),
    toolRisks: z.record(z.string(), ToolRisk),
    createdAt: IsoDateTime,
});
export type McpServer = z.infer<typeof McpServer>;

export const McpServerStatus = z.object({
    state: z.enum(['connected', 'connecting', 'disconnected', 'error', 'disabled']),
    /** 注册进工具表的完整工具名(mcp.<server>.<tool>)。 */
    tools: z.array(z.string()),
    error: z.string().nullable(),
});
export type McpServerStatus = z.infer<typeof McpServerStatus>;

/** GET /mcp/servers 的列表项:配置加上当前连接状态。 */
export const McpServerView = McpServer.extend({ status: McpServerStatus });
export type McpServerView = z.infer<typeof McpServerView>;
