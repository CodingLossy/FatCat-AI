// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 文件树与预览(ui-redesign.md 第 6 节、ADR 0046 第 7 节):只使用工具已经返回的路径和文本。
// 界面不读磁盘。控制字符和双向字符换成可见标记,预览先显示前 500 行 / 64 KiB。

import type { LiveTool } from './live-turn.js';

export const PREVIEW_MAX_LINES = 500;
export const PREVIEW_MAX_BYTES = 64 * 1024;

/** 双向控制符、零宽字符和其余不可见控制字符(保留换行、回车和制表符)。用字符串构造,避免在正则字面量里写控制字符。 */
function hiddenChars(): RegExp {
    return new RegExp(
        '[' +
            '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F' +
            '\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF' +
            ']',
        'g',
    );
}

export function markControls(text: string): string {
    return text.replace(hiddenChars(), (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function clipPreview(
    text: string,
    limits: { lines?: number; bytes?: number } = {},
): { text: string; clipped: boolean } {
    const maxLines = limits.lines ?? PREVIEW_MAX_LINES;
    const maxBytes = limits.bytes ?? PREVIEW_MAX_BYTES;
    const encoder = new TextEncoder();
    let body = text;
    let clipped = false;
    if (encoder.encode(body).byteLength > maxBytes) {
        let lo = 0;
        let hi = body.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (encoder.encode(body.slice(0, mid)).byteLength <= maxBytes) lo = mid;
            else hi = mid - 1;
        }
        body = body.slice(0, lo);
        clipped = true;
    }
    const lines = body.split('\n');
    if (lines.length > maxLines) {
        body = lines.slice(0, maxLines).join('\n');
        clipped = true;
    }
    return { text: body, clipped };
}

const LANG_BY_EXT: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    json: 'json',
    md: 'markdown',
    css: 'css',
    go: 'go',
    java: 'java',
    rs: 'rust',
    sql: 'sql',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    html: 'xml',
    xml: 'xml',
    svg: 'xml',
    diff: 'diff',
};

/** highlight.js 已注册的语言名;不认识的扩展名返回 null(纯文本)。 */
export function languageOf(path: string): string | null {
    const base = path.split(/[/\\]/).pop() ?? '';
    const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
    return LANG_BY_EXT[ext] ?? null;
}

export interface TreeNode {
    name: string;
    /** 工具返回的完整路径,用来选中和取预览。 */
    path: string;
    kind: 'dir' | 'file';
    children: TreeNode[];
}

export interface FilePreview {
    path: string;
    text: string;
    /** 工具自己声明还有没读完的内容。 */
    truncatedByTool: boolean;
    /** 搜索命中的行(从 1 开始);没有则为 null。 */
    highlightLine: number | null;
}

export interface FileWorkspace {
    /** 折叠掉的共同目录,显示在树的标题上。 */
    rootLabel: string;
    roots: TreeNode[];
    previews: Map<string, FilePreview>;
    /** 最近一次 fs.read 的路径,用来默认选中。 */
    selectedPath: string | null;
}

interface UntrustedText {
    ref: string | null;
    text: string;
    truncated: boolean;
}

function untrustedOf(output: unknown): UntrustedText | null {
    if (!output || typeof output !== 'object') return null;
    const record = output as Record<string, unknown>;
    if (record.untrusted !== true || typeof record.content !== 'string') return null;
    const source = record.source as { ref?: unknown } | undefined;
    const ref = source && typeof source.ref === 'string' ? source.ref : null;
    return { ref, text: record.content, truncated: record.truncated === true };
}

function inputPath(input: unknown): string | null {
    if (!input || typeof input !== 'object') return null;
    const path = (input as { path?: unknown }).path;
    return typeof path === 'string' && path.length > 0 ? path : null;
}

function separatorOf(path: string): string {
    return path.lastIndexOf('\\') > path.lastIndexOf('/') ? '\\' : '/';
}

function segmentsOf(path: string): string[] {
    return path.split(/[/\\]/).filter((part) => part.length > 0);
}

export function joinPath(dir: string, rel: string): string {
    const sep = separatorOf(dir);
    const extra = rel.split(/[/\\]/).filter((part) => part.length > 0);
    const base = dir.endsWith('/') || dir.endsWith('\\') ? dir.slice(0, -1) : dir;
    return [base, ...extra].join(sep);
}

interface MutableNode {
    name: string;
    path: string;
    kind: 'dir' | 'file';
    children: Map<string, MutableNode>;
}

function ensure(parent: MutableNode, name: string, path: string, kind: 'dir' | 'file'): MutableNode {
    const existing = parent.children.get(name);
    if (existing) {
        if (kind === 'dir') existing.kind = 'dir';
        return existing;
    }
    const node: MutableNode = { name, path, kind, children: new Map() };
    parent.children.set(name, node);
    return node;
}

function insertPath(root: MutableNode, full: string, kind: 'dir' | 'file'): void {
    const segs = segmentsOf(full);
    if (segs.length === 0) return;
    const sep = separatorOf(full);
    const absolute = full.startsWith('/') || /^[A-Za-z]:/.test(full);
    let parent = root;
    let acc = full.startsWith('\\\\') ? '\\\\' : absolute && sep === '/' ? '' : '';
    segs.forEach((name, index) => {
        acc = acc === '' && sep === '/' && absolute ? `${sep}${name}` : acc === '' ? name : `${acc}${sep}${name}`;
        // Windows 盘符段(C:)单独拼会丢掉分隔符之后的部分,上面的拼接已经带上 sep。
        const leaf = index === segs.length - 1;
        parent = ensure(parent, name, leaf ? full : acc, leaf ? kind : 'dir');
    });
}

function freeze(node: MutableNode): TreeNode {
    const children = [...node.children.values()].map(freeze).sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return { name: node.name, path: node.path, kind: node.kind, children };
}

/** 单链目录收到标题里,树从第一个分叉或文件开始。 */
function collapse(nodes: TreeNode[]): { label: string; roots: TreeNode[] } {
    const labels: string[] = [];
    let current = nodes;
    while (current.length === 1 && current[0]!.kind === 'dir' && current[0]!.children.length > 0) {
        labels.push(current[0]!.name);
        current = current[0]!.children;
    }
    return { label: labels.join('/'), roots: current };
}

function addList(root: MutableNode, tool: LiveTool, body: UntrustedText): void {
    const dir = body.ref ?? inputPath(tool.input);
    if (!dir) return;
    insertPath(root, dir, 'dir');
    for (const line of body.text.split(/\r?\n/)) {
        if (!line) continue;
        const [kind, name] = line.split('\t');
        if (!name) continue;
        const childKind = kind === 'dir' ? 'dir' : 'file';
        insertPath(root, joinPath(dir, name), childKind);
    }
}

function parseSearchHit(line: string): { rel: string; line: number | null } | null {
    const tab = line.indexOf('\t');
    if (tab < 0) return null;
    const head = line.slice(0, tab);
    if (line.slice(tab + 1).startsWith('(name)')) return { rel: head, line: null };
    const colon = head.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(head.slice(colon + 1))) {
        return { rel: head.slice(0, colon), line: Number(head.slice(colon + 1)) };
    }
    return { rel: head, line: null };
}

function addSearch(root: MutableNode, tool: LiveTool, body: UntrustedText, highlights: Map<string, number>): void {
    const dir = body.ref ?? inputPath(tool.input);
    if (!dir) return;
    insertPath(root, dir, 'dir');
    for (const line of body.text.split(/\r?\n/)) {
        const hit = parseSearchHit(line);
        if (!hit?.rel) continue;
        const full = joinPath(dir, hit.rel);
        insertPath(root, full, 'file');
        if (hit.line !== null && !highlights.has(full)) highlights.set(full, hit.line);
    }
}

/** 由本会话里已经返回的 fs.list / fs.search / fs.read 拼出树和预览。没有这些工具时是空树。 */
export function buildWorkspace(tools: readonly LiveTool[]): FileWorkspace {
    const root: MutableNode = { name: '', path: '', kind: 'dir', children: new Map() };
    const previews = new Map<string, FilePreview>();
    const highlights = new Map<string, number>();
    let selectedPath: string | null = null;
    for (const tool of tools) {
        if (tool.result?.error || !tool.result) continue;
        const body = untrustedOf(tool.result.output);
        if (!body) continue;
        if (tool.name === 'fs.list') addList(root, tool, body);
        else if (tool.name === 'fs.search') addSearch(root, tool, body, highlights);
        else if (tool.name === 'fs.read') {
            const path = body.ref ?? inputPath(tool.input);
            if (!path) continue;
            insertPath(root, path, 'file');
            previews.set(path, {
                path,
                text: markControls(body.text),
                truncatedByTool: body.truncated,
                highlightLine: highlights.get(path) ?? null,
            });
            selectedPath = path;
        }
    }
    for (const [path, line] of highlights) {
        const preview = previews.get(path);
        if (preview && preview.highlightLine === null) preview.highlightLine = line;
    }
    const frozen = [...root.children.values()].map(freeze);
    const collapsed = collapse(frozen);
    return { rootLabel: collapsed.label, roots: collapsed.roots, previews, selectedPath };
}

export interface WritePreview {
    path: string;
    text: string;
    pending: boolean;
    failed: boolean;
}

/** fs.write 的新内容。审批载荷里还没有旧版本时,整段按新增显示(设计文档第 6 节的退化方案)。 */
export function latestWrite(tools: readonly LiveTool[]): WritePreview | null {
    let found: WritePreview | null = null;
    for (const tool of tools) {
        if (tool.name !== 'fs.write' && tool.name !== 'fs.move') continue;
        const path = inputPath(tool.input) ?? tool.name;
        const content =
            tool.input &&
            typeof tool.input === 'object' &&
            typeof (tool.input as { content?: unknown }).content === 'string'
                ? (tool.input as { content: string }).content
                : '';
        found = {
            path,
            text: markControls(content),
            pending: Boolean(tool.approval && !tool.approval.decision),
            failed: toolStatusFailed(tool),
        };
    }
    return found;
}

function toolStatusFailed(tool: LiveTool): boolean {
    return tool.approval?.decision === 'reject' || Boolean(tool.result?.error);
}

export interface FetchedPage {
    url: string;
    text: string;
    truncated: boolean;
}

/** web.fetch / browser.read 已经返回的正文,按文本显示。 */
export function latestFetchedPage(tools: readonly LiveTool[]): FetchedPage | null {
    let found: FetchedPage | null = null;
    for (const tool of tools) {
        if (tool.name !== 'web.fetch' && tool.name !== 'browser.read' && tool.name !== 'browser.open') continue;
        if (!tool.result || tool.result.error) continue;
        const body = untrustedOf(tool.result.output);
        if (!body) continue;
        const url =
            body.ref ??
            (tool.input && typeof tool.input === 'object' && typeof (tool.input as { url?: unknown }).url === 'string'
                ? (tool.input as { url: string }).url
                : tool.name);
        found = { url, text: markControls(body.text), truncated: body.truncated };
    }
    return found;
}
