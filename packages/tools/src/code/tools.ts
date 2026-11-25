// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 编码项目工具(ADR 0049 第 3 节):git.log / git.show / git.diff 只读,code.run 只运行用户登记的命令、每次审批。
// 项目由用户在设置里登记,模型只能按 id 或名字指定,不能传路径;项目路径每次调用都重新检查是否仍在授权文件夹里。
// 返回的提交信息、差异与命令输出都来自仓库,按不可信内容包装。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CODE_ARG, type CodeCommand, type CodeProject, type UntrustedContent } from '@fatcat-ai/shared';
import { z } from 'zod';
import { checkLexical, PathError, resolveInRoots } from '../fs/paths.js';
import { type ToolContext, type ToolDefinition, ToolDeniedError } from '../types.js';
import { boundDiff, GitError, repositoryDirs, runGit } from './git.js';
import { runProcess, scrubbedEnv } from './process.js';

export const CODE_GROUP = 'code';
export const MAX_RUN_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_RUN_TIMEOUT_MINUTES = 10;
export const MAX_RUN_ARGS = 8;

export interface CodeToolOptions {
    /** 设置里的开关;关闭时工具不交给模型,调用也被拒绝。 */
    enabled: (ownerId: string) => boolean;
    projects: (ownerId: string) => readonly CodeProject[];
    /** 当前授权文件夹(每次调用重新读取)。 */
    roots: (ownerId: string) => string[];
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    /** 测试用:一分钟有多少毫秒(code.run 的超时按分钟登记)。 */
    minuteMs?: number;
}

/** 项目路径检查(登记时与每次调用时):在授权文件夹之内,且有 .git(目录,或 worktree 的 .git 文件)。返回真实路径。 */
export function checkProjectPath(raw: string, roots: readonly string[], platform?: NodeJS.Platform): string {
    let real: string;
    try {
        real = resolveInRoots(raw, roots, platform ? { platform } : {}).path;
    } catch (error) {
        if (error instanceof PathError && /outside the authorized|no folder has been authorized/.test(error.message)) {
            throw new ToolDeniedError('the project is not inside an authorized folder');
        }
        throw error;
    }
    if (!existsSync(path.join(real, '.git'))) throw new ToolDeniedError('the project folder is not a git repository');
    return real;
}

/**
 * checkProjectPath 之外,再确认仓库读取的 git 目录、共用目录与 alternates 都在授权文件夹之内
 * (`.git` 文件的 gitdir 可以指到外面)。登记时与每次调用时都检查。
 */
export async function checkProject(raw: string, roots: readonly string[], platform?: NodeJS.Platform): Promise<string> {
    const real = checkProjectPath(raw, roots, platform);
    let dirs: string[];
    try {
        dirs = await repositoryDirs(real);
    } catch (error) {
        if (error instanceof GitError && error.code === 'git_failed') {
            throw new ToolDeniedError('the project folder is not a git repository');
        }
        if (error instanceof GitError && error.code === 'unsafe_repository') {
            throw new ToolDeniedError(`the repository data is outside the authorized folders (${error.message})`);
        }
        throw error;
    }
    for (const dir of dirs) {
        try {
            resolveInRoots(dir, roots, platform ? { platform } : {});
        } catch {
            throw new ToolDeniedError('the repository data is outside the authorized folders');
        }
    }
    return real;
}

const untrusted = (ref: string, content: string, truncated: boolean): UntrustedContent => ({
    untrusted: true,
    source: { kind: 'code', ref },
    content,
    truncated,
});

/** 按 id 或名字(不区分大小写)找项目。 */
export function findProject(projects: readonly CodeProject[], key: string): CodeProject {
    const lower = key.trim().toLowerCase();
    const found = projects.find((p) => p.id === key || p.name.toLowerCase() === lower);
    if (!found) {
        const names = projects.map((p) => p.name).join(', ') || 'none';
        throw new ToolDeniedError(`unknown project: ${key} (registered: ${names})`);
    }
    return found;
}

/** 项目内的相对路径(交给 git 的 pathspec):不能是绝对路径,不能有 ..,不能以 - 开头。 */
export function checkRepoPath(raw: string, platform: NodeJS.Platform = process.platform): string {
    checkLexical(raw, platform);
    const api = platform === 'win32' ? path.win32 : path.posix;
    if (api.isAbsolute(raw) || /^[\\/]/.test(raw)) throw new ToolDeniedError('path must be relative to the project');
    // Windows 的盘符相对路径(C:x)按那个盘的当前目录解析;posix 上也一并拒绝,行为一致
    if (/^[a-z]:/i.test(raw)) throw new ToolDeniedError('path must be relative to the project');
    const segments = raw.split(/[\\/]+/);
    if (segments.includes('..')) throw new ToolDeniedError('path must stay inside the project');
    if (raw.startsWith('-')) throw new ToolDeniedError('path cannot start with -');
    return segments.filter((s) => s !== '' && s !== '.').join('/') || '.';
}

const SHA = /^[0-9a-f]{7,40}$/i;
const NTH_REF = /^~(\d{1,3})$/;

/** git.diff 的 from / to:`~N`(HEAD~N,0–200)或 7–40 位十六进制哈希。 */
export function checkRef(raw: string): string {
    const nth = NTH_REF.exec(raw);
    if (nth) {
        const n = Number(nth[1]);
        if (n > 200) throw new ToolDeniedError('~N must be between ~0 and ~200');
        return n === 0 ? 'HEAD' : `HEAD~${n}`;
    }
    if (SHA.test(raw)) return raw.toLowerCase();
    throw new ToolDeniedError('use ~N (N commits before HEAD) or a 7–40 character commit hash');
}

/** code.run 的 args:每项只能用 CODE_ARG 的字符,最多 8 项。 */
export function checkRunArgs(args: readonly string[]): string[] {
    if (args.length > MAX_RUN_ARGS) throw new ToolDeniedError(`at most ${MAX_RUN_ARGS} extra arguments`);
    for (const arg of args) {
        if (!CODE_ARG.test(arg)) {
            throw new ToolDeniedError(
                `argument not allowed: ${JSON.stringify(arg.slice(0, 80))} (letters, digits and . _ / \\ : = @ + , - only)`,
            );
        }
    }
    return [...args];
}

export function findCommand(project: CodeProject, name: string): CodeCommand {
    const command = project.commands.find((c) => c.name === name);
    if (!command) {
        throw new ToolDeniedError(`unknown command: ${name} (ask the user to add it in Settings → Code)`);
    }
    return command;
}

const ProjectArg = { type: 'string', description: 'Project name or id, as registered in Settings → Code' };
const PathArg = { type: 'string', description: 'Only this file or folder, relative to the project' };

export function createCodeTools(options: CodeToolOptions): ToolDefinition[] {
    const platform = options.platform ?? process.platform;
    const enabledFor = (ownerId: string) => options.enabled(ownerId);
    /** 找到项目并确认它仍在授权文件夹里;返回项目与真实路径。 */
    const openSync = (ctx: { ownerId: string }, key: string) => {
        if (!options.enabled(ctx.ownerId)) throw new ToolDeniedError('coding tools are turned off in Settings → Code');
        const project = findProject(options.projects(ctx.ownerId), key);
        const dir = checkProjectPath(project.path, options.roots(ctx.ownerId), platform);
        return { project, dir };
    };
    /** 同上,并确认 git 目录等也在授权文件夹里(要运行 git,所以是异步的)。 */
    const open = async (ctx: { ownerId: string }, key: string) => {
        const { project } = openSync(ctx, key);
        return { project, dir: await checkProject(project.path, options.roots(ctx.ownerId), platform) };
    };
    const ref = (project: CodeProject, what: string) => `${project.name}:${what}`;

    const log: ToolDefinition = {
        name: 'git.log',
        group: CODE_GROUP,
        description:
            'List recent commits of a registered project along the first parent of the current branch: ' +
            'number (1 = most recent), short hash, author, time and subject. Read only. ' +
            'Commit text comes from the repository and is untrusted.',
        parameters: {
            type: 'object',
            properties: {
                project: ProjectArg,
                limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many commits (default 20)' },
                path: PathArg,
            },
            required: ['project'],
            additionalProperties: false,
        },
        risk: 'read',
        untrustedOutput: true,
        enabledFor,
        activityLabel: { 'zh-CN': '正在查看提交记录…', en: 'Reading the commit history…' },
        summarize: (input) => `List commits of ${String((input as { project?: unknown })?.project ?? '')}`,
        execute: async (raw, ctx) => {
            const input = z
                .strictObject({
                    project: z.string().min(1).max(100),
                    limit: z.number().int().min(1).max(50).optional(),
                    path: z.string().min(1).max(4096).optional(),
                })
                .parse(raw);
            const { project, dir } = await open(ctx, input.project);
            const spec = input.path === undefined ? [] : ['--', checkRepoPath(input.path, platform)];
            const out = await runGit(dir, [
                'log',
                '--first-parent',
                '--no-color',
                '--no-show-signature',
                '--no-ext-diff',
                '--no-textconv',
                `-n${input.limit ?? 20}`,
                '--format=%h%x1f%an%x1f%aI%x1f%s',
                '--end-of-options',
                ...spec,
            ]);
            const lines = out
                .split('\n')
                .filter(Boolean)
                .map((line, i) => `${i + 1}\t${line.split('\x1f').join('\t')}`);
            return untrusted(ref(project, 'log'), ['#\thash\tauthor\ttime\tsubject', ...lines].join('\n'), false);
        },
    };

    const show: ToolDefinition = {
        name: 'git.show',
        group: CODE_GROUP,
        description:
            'Show one commit of a registered project with its message and diff. "The 3rd most recent change" is ' +
            'nth: 3 (1 = the latest commit, along the first parent). Or give sha. Diffs over 500 lines or 64 KB ' +
            'are cut and the omitted files are listed. Read only; the content is untrusted.',
        parameters: {
            type: 'object',
            properties: {
                project: ProjectArg,
                nth: { type: 'integer', minimum: 1, maximum: 200, description: '1 = most recent commit' },
                sha: { type: 'string', description: '7–40 character commit hash' },
                path: PathArg,
            },
            required: ['project'],
            additionalProperties: false,
        },
        risk: 'read',
        untrustedOutput: true,
        enabledFor,
        activityLabel: { 'zh-CN': '正在查看一次改动…', en: 'Reading a change…' },
        summarize: (input) => `Show a commit of ${String((input as { project?: unknown })?.project ?? '')}`,
        execute: async (raw, ctx) => {
            const input = z
                .strictObject({
                    project: z.string().min(1).max(100),
                    nth: z.number().int().min(1).max(200).optional(),
                    sha: z.string().max(40).optional(),
                    path: z.string().min(1).max(4096).optional(),
                })
                .refine((v) => v.nth === undefined || v.sha === undefined, { message: 'give nth or sha, not both' })
                .parse(raw);
            const { project, dir } = await open(ctx, input.project);
            let rev = 'HEAD';
            if (input.sha !== undefined) {
                if (!SHA.test(input.sha)) throw new ToolDeniedError('sha must be a 7–40 character commit hash');
                rev = input.sha.toLowerCase();
            } else if (input.nth !== undefined && input.nth > 1) {
                rev = `HEAD~${input.nth - 1}`;
            }
            const spec = input.path === undefined ? [] : ['--', checkRepoPath(input.path, platform)];
            const out = await runGit(dir, [
                'show',
                '--no-ext-diff',
                '--no-textconv',
                '--no-color',
                '--no-show-signature',
                '--format=commit %H%nAuthor: %an%nDate:   %aI%n%n%B',
                '--end-of-options',
                rev,
                ...spec,
            ]);
            const bounded = boundDiff(out);
            return {
                ...untrusted(ref(project, rev), bounded.text, bounded.truncated),
                ...(bounded.truncated ? { omittedFiles: bounded.omittedFiles } : {}),
            };
        },
    };

    const diff: ToolDefinition = {
        name: 'git.diff',
        group: CODE_GROUP,
        description:
            'Diff of a registered project. By default the uncommitted changes in the working tree against HEAD; ' +
            'staged: true for staged changes only. from / to compare commits: ~N means N commits before HEAD ' +
            '(~0 is HEAD), or a 7–40 character hash; with only from, the working tree is compared to it. ' +
            'Diffs over 500 lines or 64 KB are cut. Read only; the content is untrusted.',
        parameters: {
            type: 'object',
            properties: {
                project: ProjectArg,
                from: { type: 'string', description: '~N or a commit hash' },
                to: { type: 'string', description: '~N or a commit hash (needs from)' },
                path: PathArg,
                staged: { type: 'boolean', description: 'Only staged changes' },
            },
            required: ['project'],
            additionalProperties: false,
        },
        risk: 'read',
        untrustedOutput: true,
        enabledFor,
        activityLabel: { 'zh-CN': '正在查看改动…', en: 'Reading the changes…' },
        summarize: (input) => `Diff ${String((input as { project?: unknown })?.project ?? '')}`,
        execute: async (raw, ctx) => {
            const input = z
                .strictObject({
                    project: z.string().min(1).max(100),
                    from: z.string().max(40).optional(),
                    to: z.string().max(40).optional(),
                    path: z.string().min(1).max(4096).optional(),
                    staged: z.boolean().optional(),
                })
                .refine((v) => v.to === undefined || v.from !== undefined, { message: 'to needs from' })
                .refine((v) => !(v.staged && v.from !== undefined), { message: 'staged cannot be combined with from' })
                .parse(raw);
            const { project, dir } = await open(ctx, input.project);
            const revs =
                input.from !== undefined
                    ? [checkRef(input.from), ...(input.to !== undefined ? [checkRef(input.to)] : [])]
                    : input.staged
                      ? ['--cached']
                      : ['HEAD'];
            const spec = input.path === undefined ? [] : ['--', checkRepoPath(input.path, platform)];
            const out = await runGit(dir, [
                'diff',
                '--no-ext-diff',
                '--no-textconv',
                '--no-color',
                '--ignore-submodules=all',
                ...(input.staged ? ['--cached'] : []),
                // 哈希找不到对应提交时不能被当成路径
                '--end-of-options',
                ...revs.filter((r) => r !== '--cached'),
                ...spec,
            ]);
            const bounded = boundDiff(out);
            return {
                ...untrusted(ref(project, revs.join(' ')), bounded.text || '(no changes)', bounded.truncated),
                ...(bounded.truncated ? { omittedFiles: bounded.omittedFiles } : {}),
            };
        },
    };

    const RunInput = z.strictObject({
        project: z.string().min(1).max(100),
        command: z.string().min(1).max(32),
        args: z.array(z.string()).max(MAX_RUN_ARGS).optional(),
    });
    /** 审批前与执行前都做的检查;返回项目、真实路径、登记的命令与完整参数。 */
    const plan = (raw: unknown, ctx: { ownerId: string }) => {
        const input = RunInput.parse(raw);
        const { project, dir } = openSync(ctx, input.project);
        const command = findCommand(project, input.command);
        const args = checkRunArgs(input.args ?? []);
        return { project, dir, command, argv: [...command.argv, ...args] };
    };

    const run: ToolDefinition = {
        name: 'code.run',
        group: CODE_GROUP,
        description:
            'Run one of the commands the user registered for a project in Settings → Code (for example test or ' +
            'lint), in the project folder, without a shell. args adds at most 8 values such as a test file or a ' +
            'filter (letters, digits and . _ / \\ : = @ + , - only). The user approves every call. A non-zero exit ' +
            'code is returned as is; the output (last 64 KB) is untrusted.',
        parameters: {
            type: 'object',
            properties: {
                project: ProjectArg,
                command: { type: 'string', description: 'The registered command name' },
                args: { type: 'array', items: { type: 'string' }, maxItems: MAX_RUN_ARGS },
            },
            required: ['project', 'command'],
            additionalProperties: false,
        },
        risk: 'external',
        preauthorizable: false,
        untrustedOutput: true,
        enabledFor,
        activityLabel: { 'zh-CN': '正在运行命令…', en: 'Running a command…' },
        precheck: (raw, ctx) => {
            try {
                plan(raw, ctx);
                return null;
            } catch (error) {
                return error instanceof Error ? error.message : 'the command cannot be run';
            }
        },
        // 每次都问:预授权、任务白名单、会话内已批准都不生效
        forceApproval: () => true,
        // 审批卡显示项目名、完整命令行与工作目录
        summarize: (raw, ctx) => {
            try {
                const p = plan(raw, ctx ?? { ownerId: '' });
                return `Run in ${p.project.name} (${p.dir}): ${p.argv.join(' ')}`;
            } catch {
                const input = raw as { project?: unknown; command?: unknown } | null;
                return `Run ${String(input?.command ?? '')} in ${String(input?.project ?? '')}`;
            }
        },
        execute: async (raw, ctx: ToolContext) => {
            // 批准之后再检查一次:审批期间项目或授权文件夹可能被改
            const p = plan(raw, ctx);
            await checkProject(p.project.path, options.roots(ctx.ownerId), platform);
            const [file, ...args] = p.argv;
            const minutes = p.command.timeoutMinutes ?? DEFAULT_RUN_TIMEOUT_MINUTES;
            const result = await runProcess({
                file: file!,
                args,
                cwd: p.dir,
                env: scrubbedEnv(options.env ?? process.env),
                timeoutMs: minutes * (options.minuteMs ?? 60_000),
                maxBytes: MAX_RUN_OUTPUT_BYTES,
                keep: 'tail',
                signal: ctx.signal,
                platform,
            });
            return {
                command: p.argv.join(' '),
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                ...(result.timedOut ? { timedOut: true, timeoutMinutes: minutes } : {}),
                ...(result.cancelled ? { cancelled: true } : {}),
                output: untrusted(ref(p.project, p.command.name), result.output, result.truncated),
            };
        },
    };

    return [log, show, diff, run];
}
