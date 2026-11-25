// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 工作台的纯逻辑(ui-redesign.md 第 5 节):把一轮运行的工具收成 RUNNING TOOLS 行,
// 以及「面板跟随最近一次工具调用,手动点导轨则固定,直到下一轮运行」。

import type { Message } from '@fatcat-ai/shared';
import { type CodeProjectRef, isCodeTool } from './code-panel.js';
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

export type WorkbenchPanel = 'files' | 'changes' | 'mail' | 'memory' | 'browser' | 'code';

/**
 * 工具对应的面板;不认识的工具不切换(聊天里仍用原来的卡片)。
 * git.* 与 code.run,以及路径在已登记项目之内的 fs 工具,打开「代码」面板(ADR 0049 第 4 节)。
 */
export function panelForTool(
    name: string,
    input?: unknown,
    projects: readonly CodeProjectRef[] = [],
): WorkbenchPanel | null {
    if (isCodeTool({ name, input }, projects)) return 'code';
    if (name === 'fs.list' || name === 'fs.search' || name === 'fs.read') return 'files';
    if (name === 'fs.write' || name === 'fs.move') return 'changes';
    if (name.startsWith('mail.')) return 'mail';
    if (name.startsWith('memory.') || name === 'kb.search' || name.startsWith('items.')) return 'memory';
    if (name === 'web.fetch' || name.startsWith('browser.')) return 'browser';
    return null;
}

export interface PanelState {
    panel: WorkbenchPanel;
    /** 面板是否显示。空闲时为假,主视觉铺满窗口。 */
    open: boolean;
    /** 用户点了导轨或命令、或助手用 ui.panel 打开之后为真:不跟随工具,也不自动收起,直到下一轮运行。 */
    pinned: boolean;
    runId: string | null;
    /** 本轮里用户收起过面板:这一轮不再被工具自动打开。 */
    dismissedRun: string | null;
    /** 已处理过的 ui.panel 调用,避免重渲染时重复执行。 */
    uiCallId: string | null;
    /** 每次明确打开面板(点侧栏、命令、ui.panel)加一:界面据此重新载入面板内容。 */
    opened: number;
}

export function initialPanel(): PanelState {
    return { panel: 'files', open: false, pinned: false, runId: null, dismissedRun: null, uiCallId: null, opened: 0 };
}

export type PanelAction =
    | { type: 'pin'; panel: WorkbenchPanel }
    | { type: 'close' }
    | { type: 'auto-close' }
    | {
          type: 'live';
          runId: string | null;
          toolName: string | null;
          callId?: string | null;
          input?: unknown;
          projects?: readonly CodeProjectRef[];
      };

/** 运行结束后面板自动收起前的等待时间。 */
export const AUTO_CLOSE_MS = 8000;

/** ui.panel 的入参 → 要执行的动作;参数不合法时返回 null(忽略)。 */
export function uiPanelRequest(input: unknown): { action: 'open'; panel: WorkbenchPanel } | { action: 'close' } | null {
    if (!input || typeof input !== 'object') return null;
    const { action, panel } = input as { action?: unknown; panel?: unknown };
    if (action === 'close') return { action: 'close' };
    if (action === 'open' && typeof panel === 'string' && UI_PANELS.includes(panel as WorkbenchPanel)) {
        return { action: 'open', panel: panel as WorkbenchPanel };
    }
    return null;
}

const UI_PANELS: readonly WorkbenchPanel[] = ['files', 'changes', 'mail', 'memory', 'browser', 'code'];

/**
 * 新的 runId 先取消固定和「本轮已收起」,再按本轮最近一个工具切换并打开面板。
 * ui.panel 是助手明确的指令:每个 callId 只执行一次,打开即固定,收起即清除固定。
 * 固定期间忽略工具切换;本轮用户收起过则不再自动打开;没有对应面板的工具保持现状。
 */
export function reducePanel(state: PanelState, action: PanelAction): PanelState {
    if (action.type === 'pin')
        return { ...state, panel: action.panel, open: true, pinned: true, opened: state.opened + 1 };
    if (action.type === 'close') return { ...state, open: false, pinned: false, dismissedRun: state.runId };
    if (action.type === 'auto-close') return state.pinned ? state : { ...state, open: false };
    let next = state;
    if (action.runId && action.runId !== state.runId) {
        next = { ...next, pinned: false, runId: action.runId, dismissedRun: null };
    } else if (!action.runId && state.runId) next = { ...next, runId: null };
    if (action.toolName === 'ui.panel') {
        if (!action.callId || action.callId === next.uiCallId) return next;
        const request = uiPanelRequest(action.input);
        if (!request) return { ...next, uiCallId: action.callId };
        return request.action === 'open'
            ? {
                  ...next,
                  panel: request.panel,
                  open: true,
                  pinned: true,
                  dismissedRun: null,
                  uiCallId: action.callId,
                  opened: next.opened + 1,
              }
            : { ...next, open: false, pinned: false, dismissedRun: next.runId, uiCallId: action.callId };
    }
    if (next.pinned || !action.toolName) return next;
    const panel = panelForTool(action.toolName, action.input, action.projects);
    if (!panel) return next;
    if (next.dismissedRun !== null && next.dismissedRun === next.runId) return { ...next, panel };
    return { ...next, panel, open: true };
}

/** 运行已结束、面板是自动打开的(未固定)、也没有待审批时才自动收起。 */
export function shouldAutoClose(state: PanelState, runActive: boolean, approvalsPending: number): boolean {
    return state.open && !state.pinned && !runActive && approvalsPending === 0;
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
