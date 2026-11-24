// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// git 与 code.run 共用的进程运行(ADR 0049 第 3.3、3.4 节):不经 shell,有超时与输出上限,
// 取消或超时时结束整个进程树(Windows 用 taskkill /T /F,其他系统按进程组发 SIGTERM 再 SIGKILL)。
import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export interface RunOptions {
    file: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    /** 输出(stdout 与 stderr 按到达顺序合并)最多保留这么多字节。 */
    maxBytes: number;
    /** head:超出上限时停止读取并结束进程(git);tail:一直运行,只保留最后 maxBytes(code.run)。 */
    keep: 'head' | 'tail';
    /** 只读 stdout(git 的错误另外收集);默认合并 stdout 与 stderr。 */
    stdoutOnly?: boolean;
    signal?: AbortSignal | undefined;
    platform?: NodeJS.Platform;
}

export interface RunResult {
    exitCode: number | null;
    output: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
    cancelled: boolean;
    durationMs: number;
}

export class ProcessError extends Error {
    override readonly name = 'ProcessError';
    constructor(
        message: string,
        readonly code: string,
    ) {
        super(message);
    }
}

/** 结束整个进程树。 */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): void {
    if (platform === 'win32') {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
        return;
    }
    try {
        process.kill(-pid, 'SIGTERM');
    } catch {
        return;
    }
    const timer = setTimeout(() => {
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {
            // 已经退出
        }
    }, 2000);
    timer.unref();
}

/**
 * Windows 上按 PATH 与 PATHEXT 找到命令的完整路径(`pnpm` → `...\pnpm.cmd`);其他系统原样返回,由 spawn 查 PATH
 * (posix 的 execvp 不查当前目录)。Windows 的 spawn 对裸名会先查 cwd,而 cwd 是项目文件夹、内容不可信,
 * 所以找不到时抛 not_found,绝不把裸名交给 spawn。带路径分隔符的相对路径按项目目录解析(是用户登记的)。
 */
export function resolveCommand(file: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, cwd: string): string {
    if (platform !== 'win32') return file;
    const api = path.win32;
    const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    const withExts = (base: string) => (api.extname(base) !== '' ? [base] : exts.map((e) => base + e.toLowerCase()));
    const explicit = api.isAbsolute(file) || file.includes('\\') || file.includes('/');
    const candidates = explicit
        ? withExts(api.resolve(cwd, file))
        : (env.PATH ?? env.Path ?? '')
              .split(';')
              // 空项和相对目录会按当前目录解析,跳过
              .filter((dir) => dir !== '' && api.isAbsolute(dir))
              .flatMap((dir) => withExts(api.join(dir, file)));
    for (const candidate of candidates) {
        try {
            if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
        } catch {
            // 读不到的目录跳过
        }
    }
    throw new ProcessError(`${file} was not found`, 'not_found');
}

/** Windows 系统目录里的 cmd.exe 的绝对路径;不读 ComSpec(可能被改成别的程序),也不用裸名(会先查 cwd)。 */
export function systemCmd(env: NodeJS.ProcessEnv = process.env): string {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
    const cmd = path.win32.join(root, 'System32', 'cmd.exe');
    if (!path.win32.isAbsolute(cmd)) throw new ProcessError('cmd.exe was not found', 'not_found');
    return cmd;
}

/**
 * 要实际启动的程序与参数。Windows 的 .cmd / .bat 不能不经 shell 直接运行,这时用 `cmd.exe /d /s /c`;
 * 调用方保证每个参数都只含 CODE_ARG 允许的字符(没有空格、引号、% 和 ^),只有程序路径可能带空格,给它加引号。
 */
export function launchPlan(
    file: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    cwd: string,
): { file: string; args: string[]; verbatim: boolean } {
    const resolved = resolveCommand(file, env, platform, cwd);
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
        const cmd = systemCmd();
        if (process.platform === 'win32' && !existsSync(cmd)) {
            throw new ProcessError('cmd.exe was not found', 'not_found');
        }
        const line = [`"${resolved}"`, ...args].join(' ');
        return { file: cmd, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
    }
    return { file: resolved, args: [...args], verbatim: false };
}

export function runProcess(options: RunOptions): Promise<RunResult> {
    const platform = options.platform ?? process.platform;
    const started = performance.now();
    return new Promise((resolve, reject) => {
        let plan: ReturnType<typeof launchPlan>;
        try {
            plan = launchPlan(options.file, options.args, options.env, platform, options.cwd);
        } catch (error) {
            reject(error instanceof ProcessError ? error : new ProcessError(String(error), 'spawn_failed'));
            return;
        }
        if (options.signal?.aborted) {
            reject(new ProcessError('the run was cancelled', 'cancelled'));
            return;
        }
        const child = spawn(plan.file, plan.args, {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: plan.verbatim,
            // 自己成为进程组的组长,结束时连同子进程一起结束
            detached: platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let stderr = '';
        let timedOut = false;
        let cancelled = false;
        let stopped = false;
        const stop = () => {
            if (stopped || child.pid === undefined) return;
            stopped = true;
            killTree(child.pid, platform);
        };
        const take = (chunk: Buffer) => {
            if (options.keep === 'head') {
                if (truncated) return;
                if (size + chunk.length > options.maxBytes) {
                    chunks.push(chunk.subarray(0, options.maxBytes - size));
                    size = options.maxBytes;
                    truncated = true;
                    stop();
                    return;
                }
                chunks.push(chunk);
                size += chunk.length;
                return;
            }
            chunks.push(chunk);
            size += chunk.length;
            if (size > options.maxBytes * 2) {
                const all = Buffer.concat(chunks);
                chunks = [all.subarray(all.length - options.maxBytes)];
                size = options.maxBytes;
                truncated = true;
            }
        };
        child.stdout.on('data', take);
        child.stderr.on('data', (chunk: Buffer) => {
            if (!options.stdoutOnly) take(chunk);
            else if (stderr.length < 8192) stderr += chunk.toString('utf8');
        });
        const timer = setTimeout(() => {
            timedOut = true;
            stop();
        }, options.timeoutMs);
        const onAbort = () => {
            cancelled = true;
            stop();
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child.on('error', (error: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            reject(
                error.code === 'ENOENT'
                    ? new ProcessError(`${options.file} was not found`, 'not_found')
                    : new ProcessError(error.message, 'spawn_failed'),
            );
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            let buffer = Buffer.concat(chunks);
            if (options.keep === 'tail' && buffer.length > options.maxBytes) {
                buffer = buffer.subarray(buffer.length - options.maxBytes);
                truncated = true;
            }
            resolve({
                exitCode: code,
                output: buffer.toString('utf8'),
                stderr,
                truncated,
                timedOut,
                cancelled,
                durationMs: Math.round(performance.now() - started),
            });
        });
    });
}

/** 名字里含这些词的环境变量不传给子进程(不区分大小写);连接串(_URL / _URI / _DSN)常带密码,也去掉。 */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|AUTH|CRED|PAT\b|_PAT_|COOKIE|PRIVATE|_URL$|_URI$|_DSN$/i;

/** code.run 的环境:继承用户环境,去掉 FATCAT_* / AIP_* 与名字里像密钥的变量(ADR 0049 第 3.4 节)。 */
export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (/^(FATCAT_|AIP_)/i.test(name) || SECRET_NAME.test(name)) continue;
        out[name] = value;
    }
    return out;
}
