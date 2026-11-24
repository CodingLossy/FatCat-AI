// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 加固过的只读 git(ADR 0049 第 3.3 节)。仓库自己的配置可能执行命令(core.fsmonitor、diff.external、textconv、
// clean / smudge 过滤器、core.pager 等):每次调用都用 -c 关掉它们,环境只留最少的变量,不经 shell。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProcessError, runProcess } from './process.js';

export const GIT_TIMEOUT_MS = 15_000;
/** 差异的上限(ADR 0046 第 7 节):500 行 / 64 KiB。 */
export const MAX_DIFF_LINES = 500;
export const MAX_DIFF_BYTES = 64 * 1024;
/** 从 git 读取的原始输出上限;超出后停止读取并结束进程,再按上面的上限截断。 */
const MAX_RAW_BYTES = 512 * 1024;

export class GitError extends Error {
    override readonly name = 'GitError';
    constructor(
        message: string,
        readonly code: 'git_unavailable' | 'git_failed' | 'timeout',
    ) {
        super(message);
    }
}

let emptyHooks: string | null = null;
/** 一个空目录,作为 core.hooksPath:仓库里的钩子一个也不运行。 */
function emptyHooksDir(): string {
    emptyHooks ??= mkdtempSync(path.join(tmpdir(), 'fatcat-git-hooks-'));
    return emptyHooks;
}

/** git 子进程的环境:只留 PATH、SYSTEMROOT、HOME / USERPROFILE,并关掉提示、系统配置、可选锁与 pathspec 魔法。 */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_LITERAL_PATHSPECS: '1',
        GIT_PAGER: 'cat',
        LANG: 'C',
        LC_ALL: 'C',
    };
    for (const name of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'HOME', 'USERPROFILE', 'PATHEXT']) {
        const value = env[name];
        if (value !== undefined) out[name] = value;
    }
    return out;
}

/** 每次调用都加的 -c 选项(ADR 0049 第 3.3 节)。 */
export function hardeningArgs(): string[] {
    return [
        '-c',
        'core.fsmonitor=false',
        '-c',
        `core.hooksPath=${emptyHooksDir()}`,
        '-c',
        'diff.external=',
        '-c',
        'core.pager=cat',
        '-c',
        'protocol.allow=never',
        '-c',
        'core.untrackedCache=false',
    ];
}

/** 名字合法的过滤器驱动(配置里读出来的,仍然只拼进 -c 的键里)。 */
const DRIVER = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * 配置里定义的 clean / smudge / process 过滤器:对比工作区时 git 会运行 clean 过滤器,
 * 所以把每个驱动都改成空命令且不要求必须成功。读配置本身不执行任何命令。
 */
async function filterOverrides(cwd: string): Promise<string[]> {
    const result = await runRaw(cwd, ['config', '--get-regexp', '^filter\\.'], false).catch(() => null);
    if (!result) return [];
    const drivers = new Set<string>();
    for (const line of result.split('\n')) {
        const match = /^filter\.(.+)\.(clean|smudge|process|required)\s/i.exec(line);
        if (match && DRIVER.test(match[1]!)) drivers.add(match[1]!);
    }
    return [...drivers].flatMap((d) => [
        '-c',
        `filter.${d}.clean=`,
        '-c',
        `filter.${d}.smudge=`,
        '-c',
        `filter.${d}.process=`,
        '-c',
        `filter.${d}.required=false`,
    ]);
}

async function runRaw(cwd: string, args: readonly string[], withFilters: boolean): Promise<string> {
    const extra = withFilters ? await filterOverrides(cwd) : [];
    let result;
    try {
        result = await runProcess({
            file: 'git',
            args: [...hardeningArgs(), ...extra, ...args],
            cwd,
            env: gitEnv(),
            timeoutMs: GIT_TIMEOUT_MS,
            maxBytes: MAX_RAW_BYTES,
            keep: 'head',
            stdoutOnly: true,
        });
    } catch (error) {
        if (error instanceof ProcessError && error.code === 'not_found') {
            throw new GitError('git is not installed or not on PATH', 'git_unavailable');
        }
        throw error;
    }
    if (result.timedOut) throw new GitError('git did not finish within 15 seconds', 'timeout');
    if (result.exitCode !== 0 && !result.truncated) {
        const reason = result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500);
        throw new GitError(`git failed: ${reason || `exit code ${String(result.exitCode)}`}`, 'git_failed');
    }
    return result.output;
}

/** 在项目里运行一条只读 git 命令,返回 stdout。 */
export function runGit(cwd: string, args: readonly string[]): Promise<string> {
    return runRaw(cwd, args, true);
}

export interface BoundedDiff {
    text: string;
    truncated: boolean;
    /** 截断后看不到的文件(按 diff --git 头)。 */
    omittedFiles: string[];
}

/** 按 500 行 / 64 KiB 截断差异,并列出被省略的文件。 */
export function boundDiff(raw: string): BoundedDiff {
    const lines = raw.split('\n');
    let bytes = 0;
    let cut = lines.length;
    for (let i = 0; i < lines.length; i++) {
        bytes += Buffer.byteLength(lines[i]!, 'utf8') + 1;
        if (i >= MAX_DIFF_LINES || bytes > MAX_DIFF_BYTES) {
            cut = i;
            break;
        }
    }
    if (cut === lines.length) return { text: raw, truncated: false, omittedFiles: [] };
    const omitted: string[] = [];
    const shownHeader = lines
        .slice(0, cut)
        .filter((l) => l.startsWith('diff --git '))
        .pop();
    for (const line of lines.slice(cut)) {
        const match = /^diff --git a\/(.+?) b\//.exec(line);
        if (match) omitted.push(match[1]!);
    }
    // 截断点所在的文件只显示了一部分,也列出来
    const partial = shownHeader ? /^diff --git a\/(.+?) b\//.exec(shownHeader)?.[1] : undefined;
    if (partial && !omitted.includes(partial)) omitted.unshift(partial);
    return { text: lines.slice(0, cut).join('\n'), truncated: true, omittedFiles: omitted };
}
