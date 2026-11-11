// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 渠道框架(ADR 0022):适配器接口、IM 指令、富文本降级与切段、限流与退避。
// 绑定、会话与审批的编排在服务器(apps/server/src/channels),那里能拿到存储与运行管理。
export * from './types.js';
export * from './commands.js';
export * from './format.js';
export * from './limits.js';
export * from './ilink.js';
export * from './wechat.js';
