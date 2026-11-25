// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 插件服务(ADR 0040、ADR 0050 第 3 节):安装、升级、回退、市场、插件条目与数据备份。子进程运行时在 @fatcat-ai/tools/plugins。
export * from './service.js';
export * from './market.js';
export * from './items.js';
export * from './files.js';
