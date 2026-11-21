// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// system.open(ADR 0046 第 5 节,M12 PR 8):用系统默认程序打开一个文件或网址。
// 风险 external:每次审批、永不预授权;设置里打开之前整个工具被拒绝。核心只做校验,真正的「打开」由桌面壳执行
// (宿主适配器 OpenHost,经 client-call 交给已连接的桌面客户端),核心自己不启动任何进程。
// 校验在审批卡片出现之前:网址只允许 https / http / mailto、不带凭据;文件必须在已批准的目录里、存在、是普通文件,
// 且不是可执行或脚本类型(按扩展名,以及 POSIX 的可执行位)。没有参数、工作目录、环境变量,不经 shell。
import { statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { ApprovalWarning } from '@fatcat-ai/shared';
import { z } from 'zod';
import { PathError, resolveInRoots } from '../fs/paths.js';
import { type ToolContext, type ToolDefinition, ToolDeniedError } from '../types.js';

/** 拒绝的扩展名(ADR 0046 第 5.2 节),全部小写、不带点。 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set(
    (
        'exe com bat cmd msi msp scr ps1 psm1 vbs vbe js jse wsf wsh hta cpl jar lnk url reg dll sys app command sh ' +
        'bash zsh run appimage desktop dmg pkg deb rpm iso'
    ).split(' '),
);
export const OPEN_URL_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:', 'mailto:']);
/** 等桌面客户端打开的最长时间(毫秒)。 */
export const SYSTEM_OPEN_TIMEOUT_MS = 15_000;

export type OpenTarget = { kind: 'url'; url: string } | { kind: 'file'; path: string };

/** 宿主适配器:由桌面壳把已校验、已批准的目标交给系统默认程序。没有连接的桌面客户端时抛 SystemOpenError。 */
export interface OpenHost {
    open(target: OpenTarget, signal: AbortSignal, context: ToolContext): Promise<void>;
}

export interface SystemOpenToolOptions {
    /** 按 owner 读取设置里的开关;默认关闭(ADR 0046 第 4.6 节)。 */
    enabled: (ownerId: string) => boolean;
    /** 当前 owner 的授权目录(与 fs.* 相同,每次调用重新读取)。 */
    roots: (ownerId: string) => string[];
    host?: OpenHost;
    timeoutMs?: number;
    /** 测试用:当前平台(决定是否检查可执行位)。 */
    platform?: NodeJS.Platform;
}

export class SystemOpenError extends Error {
    override readonly name = 'SystemOpenError';
    constructor(
        message: string,
        readonly code: string,
    ) {
        super(message);
    }
}

const Input = z
    .object({
        url: z.string().min(1).max(2048).optional(),
        path: z.string().min(1).max(4096).optional(),
    })
    .strict()
    .refine((v) => (v.url === undefined) !== (v.path === undefined), { message: 'give exactly one of url or path' });

/** 网址校验:协议白名单、无内嵌凭据;返回规范化后的网址。不合格时抛 ToolDeniedError(按「拒绝」审计)。 */
export function checkOpenUrl(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new ToolDeniedError('not a valid address');
    }
    if (!OPEN_URL_PROTOCOLS.has(url.protocol)) {
        throw new ToolDeniedError(`only https, http and mailto addresses can be opened (got ${url.protocol})`);
    }
    if (url.username || url.password) throw new ToolDeniedError('addresses with embedded credentials are not opened');
    if (url.protocol !== 'mailto:' && !url.hostname) throw new ToolDeniedError('the address has no host');
    return url.href;
}

/** 文件名是否是拒绝的类型(看最后一个扩展名;`a.pdf.exe` 按 exe 拒绝)。 */
export function blockedExtension(path: string): string | null {
    const ext = extname(basename(path)).replace(/^\./, '').toLowerCase();
    return ext && BLOCKED_EXTENSIONS.has(ext) ? ext : null;
}

/**
 * 文件校验:在授权目录内(含符号链接解析)、存在、是普通文件、不是拒绝的类型、POSIX 上没有可执行位。
 * 返回解析后的真实路径。
 */
export function checkOpenFile(raw: string, roots: readonly string[], platform: NodeJS.Platform = process.platform) {
    let real: string;
    try {
        real = resolveInRoots(raw, roots, { platform }).path;
    } catch (error) {
        if (error instanceof PathError) throw error;
        throw new ToolDeniedError(`the path cannot be opened: ${raw}`);
    }
    // 链接解析之后再看一次扩展名:指向 .exe 的 notes.pdf 也要拒绝
    for (const p of [raw, real]) {
        const ext = blockedExtension(p);
        if (ext) throw new ToolDeniedError(`programs and scripts are never opened (.${ext})`);
    }
    const info = statSync(real);
    // macOS 的 .app 包是目录;目录一律不打开
    if (!info.isFile()) throw new ToolDeniedError('only files can be opened, not folders');
    if (platform !== 'win32' && (info.mode & 0o111) !== 0) {
        throw new ToolDeniedError('files marked as executable are never opened');
    }
    return real;
}

function targetOf(raw: unknown, roots: readonly string[], platform: NodeJS.Platform): OpenTarget {
    const input = Input.parse(raw);
    if (input.url !== undefined) return { kind: 'url', url: checkOpenUrl(input.url) };
    return { kind: 'file', path: checkOpenFile(input.path!, roots, platform) };
}

export function createSystemOpenTool(options: SystemOpenToolOptions): ToolDefinition {
    const platform = options.platform ?? process.platform;
    const roots = (ctx: { ownerId: string }) => options.roots(ctx.ownerId);
    return {
        name: 'system.open',
        description:
            'Open a file inside the authorized folders, or an https / http / mailto address, with the default ' +
            'program on the user’s computer. Needs the desktop app. The user approves every call. Programs and ' +
            'scripts are never opened. Give exactly one of url or path.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'An https, http or mailto address' },
                path: { type: 'string', description: 'A file inside the authorized folders' },
            },
            additionalProperties: false,
        },
        risk: 'external',
        preauthorizable: false,
        activityLabel: { 'zh-CN': '正在用默认程序打开…', en: 'Opening with the default program…' },
        enabledFor: (ownerId) => options.enabled(ownerId),
        // 审批之前:不合格的目标直接拒绝,不弹审批卡片
        precheck: (raw, context) => {
            try {
                targetOf(raw, roots(context), platform);
                return null;
            } catch (error) {
                return error instanceof Error ? error.message : 'the target cannot be opened';
            }
        },
        // 每次都问:会话内已批准、任务白名单都不生效
        forceApproval: () => true,
        // 审批卡片显示解析后的真实路径或完整网址(模型的说法不参与判断)
        summarize: (raw, context) => {
            try {
                const target = targetOf(raw, context ? roots(context) : [], platform);
                return target.kind === 'url'
                    ? `Open ${target.url} in the default program`
                    : `Open the file ${target.path} in the default program`;
            } catch {
                const input = raw as { url?: unknown; path?: unknown } | null;
                const shown = typeof input?.url === 'string' ? input.url : String(input?.path ?? '');
                return `Open ${shown} in the default program`;
            }
        },
        warnings: (raw): ApprovalWarning[] => {
            const input = raw as { url?: unknown } | null;
            if (typeof input?.url !== 'string') return [];
            try {
                const url = new URL(input.url);
                if (url.search.length + url.hash.length <= 200) return [];
            } catch {
                return [];
            }
            return [
                {
                    code: 'url_carries_data',
                    message: 'This address carries a long query or fragment that may contain conversation data.',
                },
            ];
        },
        execute: async (raw, context) => {
            // 批准之后再校验一次:审批期间文件可能被换掉或权限被改
            const target = targetOf(raw, roots(context), platform);
            const host = options.host;
            if (!host) {
                throw new SystemOpenError('opening files and addresses needs the desktop app', 'desktop_unavailable');
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SYSTEM_OPEN_TIMEOUT_MS);
            try {
                await host.open(target, controller.signal, context);
            } catch (error) {
                if (controller.signal.aborted && !(error instanceof SystemOpenError)) {
                    throw new SystemOpenError('the desktop app did not answer in time', 'timeout');
                }
                throw error;
            } finally {
                clearTimeout(timer);
            }
            return target.kind === 'url'
                ? `Opened ${target.url} in the default program.`
                : `Opened ${target.path} in the default program.`;
        },
    };
}
