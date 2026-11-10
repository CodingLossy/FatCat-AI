// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { PreauthConstraintKind, ToolInfo } from '@ai-personal/shared';
import { defaultApproval, isEnabled, isPreauthorizable, type PolicyOptions } from './policy.js';
import type { ToolDefinition } from './types.js';

/** 交给模型的工具声明(与 providers 的 ToolSpec 结构相同)。 */
export interface ToolSpecLike {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

/** 内置工具名:小写的点分段;MCP 工具另有 mcp. 前缀。 */
const NAME = /^[a-z][a-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;

/** 工具注册表(ADR 0010):按名称查找,列出给模型与 UI 的工具。 */
export class ToolRegistry {
    private readonly tools = new Map<string, ToolDefinition>();

    constructor(readonly options: PolicyOptions = {}) {}

    register(...tools: ToolDefinition[]): this {
        for (const tool of tools) {
            if (!NAME.test(tool.name) || tool.name.length > 200) throw new Error(`invalid tool name: ${tool.name}`);
            if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
            this.tools.set(tool.name, tool);
        }
        return this;
    }

    private readonly groups = new Map<string, string[]>();

    /**
     * 整组替换动态工具(例如一个 MCP 服务器的全部工具,ADR 0013 第 3 节):先移除该组原有的工具,再注册新的。
     * 与已有工具重名的会被跳过,返回实际注册的名字。
     */
    replaceGroup(group: string, tools: ToolDefinition[]): string[] {
        for (const name of this.groups.get(group) ?? []) this.tools.delete(name);
        const added: string[] = [];
        for (const tool of tools) {
            if (!NAME.test(tool.name) || tool.name.length > 200 || this.tools.has(tool.name)) continue;
            this.tools.set(tool.name, tool);
            added.push(tool.name);
        }
        if (added.length > 0) this.groups.set(group, added);
        else this.groups.delete(group);
        return added;
    }

    get(name: string): ToolDefinition | undefined {
        return this.tools.get(name);
    }

    get size(): number {
        return this.tools.size;
    }

    /** 交给模型的工具:被禁用的工具不提供。 */
    specs(): ToolSpecLike[] {
        return [...this.tools.values()]
            .filter((t) => isEnabled(t, this.options))
            .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    }

    /** GET /api/v1/tools。 */
    info(): ToolInfo[] {
        return [...this.tools.values()]
            .map((t) => ({
                name: t.name,
                description: t.description,
                risk: t.risk,
                approval: defaultApproval(t, this.options),
                source: t.source ?? 'builtin',
                server: t.server ?? null,
                preauthorizable: isPreauthorizable(t) && isEnabled(t, this.options),
                constraints: Object.keys(t.constraints ?? {}) as PreauthConstraintKind[],
                requiredConstraint: t.requireConstraint ?? null,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
}
