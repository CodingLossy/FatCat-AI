// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 「代码」面板的纯逻辑(ADR 0049 第 4 节):内容全部来自本会话的工具调用(git.log / git.show / git.diff / code.run,
// 以及路径在已登记项目之内的 fs.read / fs.write)。界面不读文件、不调 git;所有文本都是不可信内容,按文本显示,
// 控制字符和双向字符换成可见标记,超过 500 行 / 64 KiB 的部分不显示。
import { clipPreview, markControls } from './file-workspace.js';
import type { LiveTool } from './live-turn.js';

export interface CodeProjectRef {
    id: string;
    name: string;
    path: string;
}

const CODE_TOOLS = new Set(['git.log', 'git.show', 'git.diff', 'code.run']);
const FS_TOOLS = new Set(['fs.read', 'fs.write', 'fs.move']);

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 路径在不在某个目录里(只按字符串判断,用来决定显示哪个面板;真正的检查在服务器)。 */
export function insidePath(target: string, dir: string): boolean {
    const t = norm(target);
    const d = norm(dir);
    return d !== '' && (t === d || t.startsWith(`${d}/`));
}

function inputOf(tool: Pick<LiveTool, 'input'>): Record<string, unknown> {
    return tool.input && typeof tool.input === 'object' ? (tool.input as Record<string, unknown>) : {};
}

/** 这次调用属于哪个已登记项目:代码工具按 project 参数(id 或名字),fs 工具按路径。 */
export function projectOfTool(
    tool: Pick<LiveTool, 'name' | 'input'>,
    projects: readonly CodeProjectRef[],
): CodeProjectRef | null {
    const input = inputOf(tool);
    if (CODE_TOOLS.has(tool.name)) {
        const key = typeof input.project === 'string' ? input.project.trim() : '';
        const lower = key.toLowerCase();
        return projects.find((p) => p.id === key || p.name.toLowerCase() === lower) ?? null;
    }
    if (FS_TOOLS.has(tool.name)) {
        const paths = [input.path, input.from, input.to].filter((p): p is string => typeof p === 'string');
        return projects.find((p) => paths.some((path) => insidePath(path, p.path))) ?? null;
    }
    return null;
}

/** 这次调用是否该打开「代码」面板。 */
export function isCodeTool(tool: Pick<LiveTool, 'name' | 'input'>, projects: readonly CodeProjectRef[]): boolean {
    if (CODE_TOOLS.has(tool.name)) return true;
    return FS_TOOLS.has(tool.name) && projectOfTool(tool, projects) !== null;
}

interface Untrusted {
    ref: string | null;
    text: string;
    truncated: boolean;
}

function untrustedOf(value: unknown): Untrusted | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (record.untrusted !== true || typeof record.content !== 'string') return null;
    const source = record.source as { ref?: unknown } | undefined;
    return {
        ref: source && typeof source.ref === 'string' ? source.ref : null,
        text: record.content,
        truncated: record.truncated === true,
    };
}

/** 显示前的处理:控制字符换成可见标记,再按 500 行 / 64 KiB 截断。 */
function safeText(text: string): { text: string; clipped: boolean } {
    return clipPreview(markControls(text));
}

export interface Commit {
    /** 1 = 最近一次。 */
    n: number;
    hash: string;
    author: string;
    time: string;
    subject: string;
}

/** git.log 的结果:第一行是表头,之后每行 `n\thash\tauthor\ttime\tsubject`。 */
export function parseLog(text: string): Commit[] {
    const out: Commit[] = [];
    for (const line of text.split('\n').slice(1)) {
        const [n, hash, author, time, ...subject] = line.split('\t');
        if (!n || !hash || !/^\d+$/.test(n) || !/^[0-9a-f]{4,64}$/i.test(hash)) continue;
        out.push({
            n: Number(n),
            hash,
            author: markControls(author ?? ''),
            time: time ?? '',
            subject: markControls(subject.join('\t')),
        });
    }
    return out;
}

export interface GitDiffLine {
    kind: 'add' | 'del' | 'ctx' | 'hunk' | 'file' | 'meta';
    oldNo?: number;
    newNo?: number;
    text: string;
}

const GIT_HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * git 的差异文本 → 带行号的行。`diff --git` 是文件头,index / --- / +++ 等是元信息,不算增删;
 * 认不出的行按上下文显示,绝不当作可执行的东西。
 */
export function parseGitDiff(text: string): GitDiffLine[] {
    const out: GitDiffLine[] = [];
    let oldNo = 0;
    let newNo = 0;
    let inHunk = false;
    for (const raw of text === '' ? [] : text.split('\n')) {
        if (raw.startsWith('diff --git ')) {
            inHunk = false;
            out.push({ kind: 'file', text: raw.replace(/^diff --git a\/(.+?) b\/.*$/, '$1') });
            continue;
        }
        const hunk = GIT_HUNK.exec(raw);
        if (hunk) {
            inHunk = true;
            oldNo = Number(hunk[1]);
            newNo = Number(hunk[2]);
            out.push({ kind: 'hunk', text: raw });
            continue;
        }
        if (!inHunk) {
            out.push({ kind: 'meta', text: raw });
            continue;
        }
        if (raw.startsWith('+')) out.push({ kind: 'add', newNo: newNo++, text: raw.slice(1) });
        else if (raw.startsWith('-')) out.push({ kind: 'del', oldNo: oldNo++, text: raw.slice(1) });
        else if (raw.startsWith('\\')) out.push({ kind: 'meta', text: raw });
        else out.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
    }
    return out;
}

export interface CommitView {
    /** 完整哈希(git.show 的第一行 `commit <sha>`)。 */
    sha: string | null;
    /** 提交说明等差异之前的部分。 */
    header: string;
    lines: GitDiffLine[];
    clipped: boolean;
    omittedFiles: string[];
}

/** git.show / git.diff 的输出:`diff --git` 之前是提交头和说明,之后是差异。 */
export function splitShow(text: string): CommitView {
    const safe = safeText(text);
    const at = safe.text.search(/^diff --git /m);
    const header = at < 0 ? safe.text : safe.text.slice(0, at);
    const diff = at < 0 ? '' : safe.text.slice(at);
    const sha = /^commit ([0-9a-f]{40,64})$/m.exec(header)?.[1] ?? null;
    return {
        sha,
        header: header.replace(/\n+$/, ''),
        lines: parseGitDiff(diff),
        clipped: safe.clipped,
        omittedFiles: [],
    };
}

export type ViewerItem =
    | { kind: 'show'; callId: string; title: string; view: CommitView }
    | { kind: 'diff'; callId: string; title: string; view: CommitView }
    | { kind: 'write'; callId: string; path: string; tool: LiveTool }
    | { kind: 'file'; callId: string; path: string; text: string; clipped: boolean };

export interface RunView {
    callId: string;
    command: string;
    state: 'waiting' | 'running' | 'done' | 'failed' | 'rejected';
    exitCode: number | null;
    durationMs: number | null;
    timedOut: boolean;
    cancelled: boolean;
    output: string;
    clipped: boolean;
    error: string | null;
}

export interface CodeView {
    project: CodeProjectRef | null;
    /** 最近一次 git.log。 */
    commits: Commit[];
    /** 打开过的提交(git.show),按完整哈希。 */
    shows: Map<string, Extract<ViewerItem, { kind: 'show' }>>;
    /** 最近一次 show / diff / fs.write / fs.read,面板默认显示它。 */
    latest: ViewerItem | null;
    run: RunView | null;
}

function omittedOf(output: unknown): string[] {
    const list = (output as { omittedFiles?: unknown } | null)?.omittedFiles;
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string').map(markControls) : [];
}

function runOf(tool: LiveTool): RunView {
    const input = inputOf(tool);
    const out = (tool.result?.output ?? null) as Record<string, unknown> | null;
    const ran = typeof out?.command === 'string' ? out.command : null;
    const fallback = [input.command, ...(Array.isArray(input.args) ? input.args : [])]
        .filter((a): a is string => typeof a === 'string')
        .join(' ');
    const command = markControls(ran ?? fallback);
    const body = untrustedOf(out?.output);
    const tail = body ? tailLines(body.text) : '';
    const safe = body ? safeText(tail) : { text: '', clipped: false };
    let state: RunView['state'] = 'running';
    if (tool.approval && !tool.approval.decision) state = 'waiting';
    else if (tool.approval?.decision === 'reject') state = 'rejected';
    else if (tool.result?.error) state = 'failed';
    else if (tool.result) state = out?.exitCode === 0 ? 'done' : 'failed';
    return {
        callId: tool.callId,
        command,
        state,
        exitCode: typeof out?.exitCode === 'number' ? out.exitCode : null,
        durationMs: typeof out?.durationMs === 'number' ? out.durationMs : null,
        timedOut: out?.timedOut === true,
        cancelled: out?.cancelled === true,
        output: safe.text,
        clipped: safe.clipped || Boolean(body?.truncated) || (body !== null && tail !== body.text),
        error: tool.result?.error ? markControls(tool.result.error) : null,
    };
}

/** 测试输出只看末尾:最多 500 行。 */
function tailLines(text: string, max = 500): string {
    const lines = text.split('\n');
    return lines.length > max ? lines.slice(lines.length - max).join('\n') : text;
}

/** 本会话的工具调用 → 面板内容;只看最近一个代码项目的调用。 */
export function buildCodeView(tools: readonly LiveTool[], projects: readonly CodeProjectRef[]): CodeView {
    const view: CodeView = { project: null, commits: [], shows: new Map(), latest: null, run: null };
    for (const tool of tools) {
        if (!isCodeTool(tool, projects)) continue;
        const project = projectOfTool(tool, projects);
        if (project && view.project?.id !== project.id) {
            // 换了项目:之前项目的内容不再显示
            view.project = project;
            view.commits = [];
            view.shows = new Map();
            view.latest = null;
            view.run = null;
        }
        const input = inputOf(tool);
        if (tool.name === 'code.run') {
            view.run = runOf(tool);
            continue;
        }
        if (tool.name === 'fs.write' || tool.name === 'fs.move') {
            const path = typeof input.path === 'string' ? input.path : typeof input.to === 'string' ? input.to : '';
            view.latest = { kind: 'write', callId: tool.callId, path: markControls(path), tool };
            continue;
        }
        if (!tool.result || tool.result.error) continue;
        const body = untrustedOf(tool.result.output);
        if (!body) continue;
        if (tool.name === 'git.log') {
            view.commits = parseLog(body.text);
        } else if (tool.name === 'git.show' || tool.name === 'git.diff') {
            const parsed = splitShow(body.text);
            const item = {
                callId: tool.callId,
                title: markControls(body.ref?.replace(/^[^:]*:/, '') ?? tool.name),
                view: {
                    ...parsed,
                    clipped: parsed.clipped || body.truncated,
                    omittedFiles: omittedOf(tool.result.output),
                },
            };
            if (tool.name === 'git.show') {
                const show = { kind: 'show' as const, ...item };
                if (parsed.sha) view.shows.set(parsed.sha, show);
                view.latest = show;
            } else {
                view.latest = { kind: 'diff', ...item };
            }
        } else if (tool.name === 'fs.read') {
            const safe = safeText(body.text);
            const path = typeof input.path === 'string' ? input.path : '';
            view.latest = {
                kind: 'file',
                callId: tool.callId,
                path: markControls(path),
                text: safe.text,
                clipped: safe.clipped || body.truncated,
            };
        }
    }
    return view;
}

/** 提交列表里的短哈希对应的已打开提交。 */
export function showFor(view: CodeView, hash: string): Extract<ViewerItem, { kind: 'show' }> | null {
    const lower = hash.toLowerCase();
    for (const [sha, show] of view.shows) if (sha.startsWith(lower)) return show;
    return null;
}

/** 路径相对项目目录显示;不在项目里就原样显示。 */
export function relativeTo(path: string, dir: string): string {
    if (!insidePath(path, dir)) return path;
    const rest = path.slice(dir.replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '');
    return rest === '' ? '.' : rest;
}
