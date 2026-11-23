// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 工具分组(ADR 0047 第 1 节):组名由工具名推出;核心组始终交给模型,其余组要先用 tools.enable 开启。

/** 始终交给模型的组(ADR 0047 第 1.2 节)。 */
export const CORE_TOOL_GROUPS: readonly string[] = ['memory', 'calc', 'time', 'items', 'kb', 'ui', 'delegate', 'tools'];

/**
 * 工具名推出的组名:第一个 `.` 之前的部分(`fs.read` → `fs`);MCP 工具是 `mcp.<server>`,插件工具是
 * `plugin.<id>`;没有 `.` 的工具各自成组(`calc` → `calc`)。
 */
export function groupOf(name: string): string {
    const segments = name.split('.');
    if ((segments[0] === 'mcp' || segments[0] === 'plugin') && segments.length > 1) {
        return `${segments[0]}.${segments[1]}`;
    }
    return segments[0]!;
}

export function isCoreGroup(group: string): boolean {
    return CORE_TOOL_GROUPS.includes(group);
}
