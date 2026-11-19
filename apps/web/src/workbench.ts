// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 工作台的纯逻辑(docs/design/ui-redesign.md 第 5、6 节):RUNNING TOOLS 的行、面板跟随工具切换、
// 文件树与预览。只处理现有 run 事件里已经送达的工具结果,不读磁盘、不新增接口;
// 工具结果是不可信数据,这里只当文本处理。
import type { LiveTool } from './live-turn.js';

export type PanelId = 'chat' | 'files';

export interface PanelState {
    panel: PanelId;
    /** 用户手动点过导轨:固定在该面板,直到下一轮运行开始。 */
    pinned: boolean;
}

export const INITIAL_PANEL: PanelState = { panel: 'chat', pinned: false };

/** 读文件系统的工具对应「文件」面板;其他工具的结果仍在对话里的卡片中显示(各自的面板在后续 PR)。 */
export function panelForTool(name: string): PanelId | null {
    return name === 'fs.list' || name === 'fs.read' ? 'files' : null;
}

/** 一次工具调用出现:没有固定时跟随它切换面板。 */
export function followTool(state: PanelState, toolName: string): PanelState {
    const target = panelForTool(toolName);
    return state.pinned || !target || target === state.panel ? state : { ...state, panel: target };
}

export function pinPanel(panel: PanelId): PanelState {
    return { panel, pinned: true };
}

/** 新一轮运行开始:解除固定,面板重新跟随工具。 */
export function startRun(state: PanelState): PanelState {
    return state.pinned ? { ...state, pinned: false } : state;
}

// ---------- RUNNING TOOLS ----------

export type RunningStatus = 'running' | 'done' | 'error' | 'approval';

export interface RunningRow {
    callId: string;
    name: string;
    detail: string;
    status: RunningStatus;
}

const DETAIL_MAX = 60;

function clip(text: string): string {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > DETAIL_MAX ? `${one.slice(0, DETAIL_MAX - 1)}…` : one;
}

/** 参数简述:待审批时用审批摘要,否则取第一个字符串参数。 */
export function toolDetail(tool: LiveTool): string {
    if (tool.approval?.summary) return clip(tool.approval.summary);
    if (tool.input && typeof tool.input === 'object') {
        for (const value of Object.values(tool.input as Record<string, unknown>)) {
            if (typeof value === 'string' && value.trim()) return clip(value);
        }
    }
    return '';
}

export function toolStatus(tool: LiveTool): RunningStatus {
    if (tool.result) return tool.result.error ? 'error' : 'done';
    if (tool.approval?.decision === 'reject') return 'error';
    if (tool.approval && !tool.approval.decision) return 'approval';
    return 'running';
}

/** 最新的在最后;最多 `max` 行,更早的折叠成 `more`。 */
export function runningRows(tools: readonly LiveTool[], max = 4): { rows: RunningRow[]; more: number } {
    const hidden = Math.max(0, tools.length - max);
    const rows = tools.slice(hidden).map((tool) => ({
        callId: tool.callId,
        name: tool.name,
        detail: toolDetail(tool),
        status: toolStatus(tool),
    }));
    return { rows, more: hidden };
}

// ---------- 文件树与预览 ----------

export interface FsEntry {
    kind: 'dir' | 'file' | 'link' | 'other';
    name: string;
    size?: number;
}

/** 不可信内容包装({ untrusted: true, source, content, truncated })里取文本;格式不符返回 null。 */
export function untrustedText(output: unknown): { ref: string; text: string; truncated: boolean } | null {
    if (!output || typeof output !== 'object') return null;
    const o = output as { content?: unknown; source?: { ref?: unknown }; truncated?: unknown };
    if (typeof o.content !== 'string' || typeof o.source?.ref !== 'string') return null;
    return { ref: o.source.ref, text: o.content, truncated: o.truncated === true };
}

/** `fs.list` 的输出:每行 `类型\t名称[\t字节数]`。看不懂的行直接跳过。 */
export function parseFsList(text: string): FsEntry[] {
    const entries: FsEntry[] = [];
    for (const line of text.split('\n')) {
        const [kind, name, size] = line.split('\t');
        if (!name || (kind !== 'dir' && kind !== 'file' && kind !== 'link' && kind !== 'other')) continue;
        const bytes = size === undefined ? NaN : Number(size);
        entries.push({ kind, name, ...(Number.isFinite(bytes) ? { size: bytes } : {}) });
    }
    return entries;
}

export interface FilePreview {
    path: string;
    /** 已收到的全部文本行;默认只显示前 `PREVIEW_MAX_LINES` 行,「显示更多」只从这里取,不再读磁盘。 */
    lines: string[];
    /** 工具自己截断了内容(只读到文件的一部分)。 */
    truncated: boolean;
}

export const PREVIEW_MAX_LINES = 500;
/** 预览最多保留的字符数(64 KiB 量级),再大的结果只显示开头。 */
export const PREVIEW_MAX_CHARS = 65_536;

export interface FileTreeNode {
    name: string;
    path: string;
    kind: FsEntry['kind'];
    /** 目录已列出时的子项;未列出的目录为 undefined。 */
    children?: FileTreeNode[];
}

export interface FilesModel {
    roots: FileTreeNode[];
    /** 最近一次读到的文件;按路径索引的完整表在 `previews`。 */
    latest: FilePreview | null;
    previews: Map<string, FilePreview>;
}

function sepOf(path: string): string {
    return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

function joinPath(dir: string, name: string): string {
    const sep = sepOf(dir);
    return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function parentOf(path: string): string {
    const sep = sepOf(path);
    const i = path.lastIndexOf(sep);
    return i <= 0 ? '' : path.slice(0, i);
}

/**
 * 从已完成的 `fs.list` / `fs.read` 结果构建文件树与预览。树的根是没有被其他已列出目录包含的目录;
 * 未列出的子目录显示为叶子。同一个目录列了多次,以最后一次为准。
 */
export function buildFilesModel(tools: readonly LiveTool[]): FilesModel {
    const dirs = new Map<string, FsEntry[]>();
    const previews = new Map<string, FilePreview>();
    let latest: FilePreview | null = null;
    for (const tool of tools) {
        if (!tool.result || tool.result.error) continue;
        const text = untrustedText(tool.result.output);
        if (!text) continue;
        if (tool.name === 'fs.list') {
            dirs.set(text.ref, parseFsList(text.text));
        } else if (tool.name === 'fs.read') {
            const preview: FilePreview = {
                path: text.ref,
                lines: text.text.slice(0, PREVIEW_MAX_CHARS).split('\n'),
                truncated: text.truncated || text.text.length > PREVIEW_MAX_CHARS,
            };
            previews.set(text.ref, preview);
            latest = preview;
        }
    }
    const node = (name: string, path: string, kind: FsEntry['kind']): FileTreeNode => {
        const entries = kind === 'dir' ? dirs.get(path) : undefined;
        return {
            name,
            path,
            kind,
            ...(entries ? { children: entries.map((e) => node(e.name, joinPath(path, e.name), e.kind)) } : {}),
        };
    };
    const roots = [...dirs.keys()]
        .filter((dir) => !dirs.has(parentOf(dir)))
        .map((dir) => node(dir.slice(dir.lastIndexOf(sepOf(dir)) + 1) || dir, dir, 'dir'));
    return { roots, latest, previews };
}

/** 文件扩展名里的语言名,用在预览状态栏里;不认识就返回 null。 */
export function languageOf(path: string): string | null {
    const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
    const names: Record<string, string> = {
        ts: 'TypeScript',
        tsx: 'TypeScript',
        js: 'JavaScript',
        jsx: 'JavaScript',
        json: 'JSON',
        md: 'Markdown',
        py: 'Python',
        rs: 'Rust',
        go: 'Go',
        java: 'Java',
        css: 'CSS',
        html: 'HTML',
        yml: 'YAML',
        yaml: 'YAML',
        sh: 'Shell',
        sql: 'SQL',
    };
    return ext ? (names[ext] ?? null) : null;
}

// ---------- 全局搜索的命令 ----------

export interface CommandItem {
    id: string;
    label: string;
}

/** 命令按名称包含查询词(不区分大小写)过滤;空查询返回空(不展示整张列表)。 */
export function filterCommands(commands: readonly CommandItem[], query: string): CommandItem[] {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : [];
}

/** 搜索框里的快捷键提示:macOS 显示 ⌘K,其他平台显示 Ctrl K(键名不随语言变化)。 */
export function shortcutHint(platform: string): string {
    return /mac|iphone|ipad/i.test(platform) ? '⌘K' : 'Ctrl K';
}
