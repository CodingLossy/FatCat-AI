// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 工作台的纯逻辑(ui-redesign.md 第 5 节):把一轮运行的工具收成 RUNNING TOOLS 行,
// 以及「面板跟随最近一次工具调用,手动点导轨则固定,直到下一轮运行」。

import type { Message } from '@fatcat-ai/shared';
import type { LiveTool, LiveTurn } from './live-turn.js';

export type ToolRowStatus = 'running' | 'done' | 'failed' | 'waiting';

export interface ToolRow {
    callId: string;
    name: string;
    /** 工具名加一句参数简述,例如 fs.read(a.ts)。 */
    summary: string;
    status: ToolRowStatus;
}

export const RUNNING_TOOLS_LIMIT = 4;

/** 从入参里取一行能看懂的简述:路径只留最后一段,过长就截断。 */
export function toolArg(input: unknown): string {
    if (!input || typeof input !== 'object') return '';
    const record = input as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path.split(/[/\\]/).pop() : undefined;
    const raw =
        (path && path.length > 0 ? path : undefined) ??
        (typeof record.url === 'string' ? record.url : undefined) ??
        (typeof record.query === 'string' ? record.query : undefined) ??
        (typeof record.text === 'string' ? record.text : undefined) ??
        '';
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > 42 ? `${text.slice(0, 41)}…` : text;
}

export function toolSummary(name: string, input: unknown): string {
    const arg = toolArg(input);
    return arg ? `${name}(${arg})` : name;
}

/** 等待审批优先于结果;拒绝或工具错误是失败;有结果且没有错误是完成;否则仍在跑。 */
export function toolStatus(tool: Pick<LiveTool, 'approval' | 'result'>): ToolRowStatus {
    if (tool.approval && !tool.approval.decision) return 'waiting';
    if (tool.approval?.decision === 'reject') return 'failed';
    if (tool.result?.error) return 'failed';
    if (tool.result) return 'done';
    return 'running';
}

/**
 * 本轮工具,按发生顺序,最新的在最后。超过 limit 时只保留最后几行,更早的条数交给调用方显示成「+N」。
 */
export function visibleToolRows(
    tools: readonly Pick<LiveTool, 'callId' | 'name' | 'input' | 'approval' | 'result'>[],
    limit = RUNNING_TOOLS_LIMIT,
): { rows: ToolRow[]; hidden: number } {
    const rows: ToolRow[] = tools.map((tool) => ({
        callId: tool.callId,
        name: tool.name,
        summary: toolSummary(tool.name, tool.input),
        status: toolStatus(tool),
    }));
    if (rows.length <= limit) return { rows, hidden: 0 };
    return { rows: rows.slice(rows.length - limit), hidden: rows.length - limit };
}

export type WorkbenchPanel = 'files' | 'search' | 'changes' | 'mail' | 'memory' | 'browser';

/** 工具名对应的面板;不认识的工具不切换(聊天里仍用原来的卡片)。 */
export function panelForTool(name: string): WorkbenchPanel | null {
    if (name === 'fs.list' || name === 'fs.search' || name === 'fs.read') return 'files';
    if (name === 'fs.write' || name === 'fs.move') return 'changes';
    if (name.startsWith('mail.')) return 'mail';
    if (name.startsWith('memory.') || name === 'kb.search' || name.startsWith('items.')) return 'memory';
    if (name === 'web.fetch' || name.startsWith('browser.')) return 'browser';
    return null;
}

export interface PanelState {
    panel: WorkbenchPanel;
    /** 用户点了导轨之后为真,直到下一轮运行开始。 */
    pinned: boolean;
    runId: string | null;
}

export function initialPanel(): PanelState {
    return { panel: 'files', pinned: false, runId: null };
}

export type PanelAction =
    { type: 'pin'; panel: WorkbenchPanel } | { type: 'live'; runId: string | null; toolName: string | null };

/**
 * 新的 runId 先取消固定,再按本轮最近一个工具切换。
 * 固定期间忽略工具切换。没有对应面板的工具保持当前面板。
 */
export function reducePanel(state: PanelState, action: PanelAction): PanelState {
    if (action.type === 'pin') return { ...state, panel: action.panel, pinned: true };
    let next = state;
    if (action.runId && action.runId !== state.runId) next = { ...next, pinned: false, runId: action.runId };
    else if (!action.runId && state.runId) next = { ...next, runId: null };
    if (next.pinned || !action.toolName) return next;
    const panel = panelForTool(action.toolName);
    return panel ? { ...next, panel } : next;
}

function mergeTool(prev: LiveTool | undefined, next: LiveTool): LiveTool {
    if (!prev) return next;
    return {
        ...prev,
        ...next,
        ...(next.approval ? { approval: next.approval } : prev.approval ? { approval: prev.approval } : {}),
        ...(next.result ? { result: next.result } : prev.result ? { result: prev.result } : {}),
    };
}

/** 已保存的消息加上正在进行的一轮,按出现顺序。进行中的调用覆盖同 callId 的旧记录。 */
export function toolsFromTranscript(messages: readonly Message[], live: LiveTurn | null): LiveTool[] {
    const byId = new Map<string, LiveTool>();
    const order: string[] = [];
    const put = (tool: LiveTool) => {
        if (!byId.has(tool.callId)) order.push(tool.callId);
        byId.set(tool.callId, mergeTool(byId.get(tool.callId), tool));
    };
    const results = new Map<string, LiveTool['result']>();
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === 'tool-result') {
                results.set(part.callId, { output: part.output, ...(part.error ? { error: part.error } : {}) });
            }
        }
    }
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type !== 'tool-call') continue;
            const result = results.get(part.callId);
            put({
                callId: part.callId,
                name: part.name,
                input: part.input,
                ...(result ? { result } : {}),
            });
        }
    }
    if (live) for (const tool of live.tools) put(tool);
    return order.map((id) => byId.get(id)!);
}

/** 命令列表的过滤:空查询保留全部;否则名称或关键词里包含查询(不区分大小写)。 */
export function matchCommands<T extends { label: string; keywords: string }>(
    commands: readonly T[],
    query: string,
): T[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...commands];
    return commands.filter((command) => `${command.label}\n${command.keywords}`.toLowerCase().includes(q));
}
