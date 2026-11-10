// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 工具的定义、注册表与审批策略在 @fatcat-ai/tools(ADR 0010);这里只保留 agent 侧的别名。
import type { ToolDefinition } from '@fatcat-ai/tools';

export type { ToolContext, ToolDefinition } from '@fatcat-ai/tools';

/** M1 的名称,保留为 ToolDefinition 的别名。 */
export type AgentTool = ToolDefinition;

/** 批准 / 拒绝的结果:resolved 表示决定已生效。 */
export type ApprovalOutcome = 'resolved' | 'not_pending' | { invalid: string };
