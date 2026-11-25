// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 渠道中枢(ADR 0022、ADR 0050 第 2 节):入站编排(去重、过滤、限流、指令、审批短码、排队交给 runner)与微信扫码授权。
// 单独的子路径:只用适配器的代码 import 根入口,不会把 agent 与存储拉进来。
export * from './hub.js';
export * from './wechat-channels.js';
