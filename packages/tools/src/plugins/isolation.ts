// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 操作系统层面的网络隔离(PR 2b 的网络方案,见 ADR 0040 实现注记):Node 24 没有网络权限,预加载只是同一 realm 里的
// 纵深防御;真正的边界放在操作系统。Linux 用 `unshare -rn`(空的网络命名空间),macOS 用 `sandbox-exec`(deny network*)。
// 只在启动时探测成功才启用;Windows 没有不需要特权与原生代码的办法,返回 none。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export type NetIsolationKind = 'unshare' | 'sandbox-exec' | 'none';

export interface NetIsolation {
    kind: NetIsolationKind;
    /** 把插件的启动命令包一层;kind 为 none 时原样返回。 */
    wrap(command: string, args: string[]): { command: string; args: string[] };
}

export const SANDBOX_PROFILE = '(version 1)(allow default)(deny network*)';

const NONE: NetIsolation = { kind: 'none', wrap: (command, args) => ({ command, args }) };

function firstExisting(paths: readonly string[]): string | null {
    return paths.find((p) => existsSync(p)) ?? null;
}

/**
 * 探测当前平台能否在不需要特权的情况下禁止插件进程联网。探测时真的用同样的方式起一个 node,
 * 并确认里面看不到任何非回环的网络接口。
 */
export function detectNetIsolation(options: { nodePath?: string; platform?: NodeJS.Platform } = {}): NetIsolation {
    const node = options.nodePath ?? process.execPath;
    const platform = options.platform ?? process.platform;
    const check = `const i=require('node:os').networkInterfaces();process.exit(Object.values(i).flat().some(a=>a&&!a.internal)?1:0)`;
    if (platform === 'linux') {
        const unshare = firstExisting(['/usr/bin/unshare', '/bin/unshare']);
        if (!unshare) return NONE;
        const wrap = (command: string, args: string[]) => ({
            command: unshare,
            args: ['--user', '--map-root-user', '--net', '--', command, ...args],
        });
        const probe = wrap(node, ['-e', check]);
        const result = spawnSync(probe.command, probe.args, { stdio: 'ignore', timeout: 10_000 });
        return result.status === 0 ? { kind: 'unshare', wrap } : NONE;
    }
    if (platform === 'darwin') {
        const sandbox = firstExisting(['/usr/bin/sandbox-exec']);
        if (!sandbox) return NONE;
        const wrap = (command: string, args: string[]) => ({
            command: sandbox,
            args: ['-p', SANDBOX_PROFILE, command, ...args],
        });
        const probe = wrap(node, ['-e', 'process.exit(0)']);
        const result = spawnSync(probe.command, probe.args, { stdio: 'ignore', timeout: 10_000 });
        return result.status === 0 ? { kind: 'sandbox-exec', wrap } : NONE;
    }
    return NONE;
}

export const NO_NET_ISOLATION = NONE;
