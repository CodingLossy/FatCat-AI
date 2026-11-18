// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 操作系统层面的网络隔离(PR 2b 的网络方案,见 ADR 0040 实现注记):Node 24 没有网络权限,预加载只是同一 realm 里的
// 纵深防御;真正的边界放在操作系统。Linux 用 `unshare -rn`(空的网络命名空间),macOS 用 `sandbox-exec`(deny network*)。
// 只在启动时探测成功才启用;Windows 没有不需要特权与原生代码的办法,返回 none。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

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

function runProbe(command: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        execFile(command, args, { timeout: 10_000, windowsHide: true }, (error) => resolve(error === null));
    });
}

/** macOS 的探测:父进程开一个本机端口,沙箱里的子进程去连,连不上(被拒绝)才算隔离有效;连上了说明沙箱没拦住。 */
async function sandboxDeniesConnect(command: string, args: (port: number) => string[]): Promise<boolean> {
    const server = createServer((socket) => socket.destroy());
    try {
        const port = await new Promise<number>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const address = server.address();
                if (address && typeof address === 'object') resolve(address.port);
                else reject(new Error('no port'));
            });
        });
        return await runProbe(command, args(port));
    } catch {
        return false;
    } finally {
        server.close();
    }
}

/**
 * 探测当前平台能否在不需要特权的情况下禁止插件进程联网(异步,不阻塞事件循环;服务启动时探测一次并缓存)。
 * Linux:真的用同样的方式起一个 node,确认里面看不到任何非回环的网络接口。
 * macOS:真的尝试连一次父进程开的本机端口,连不上才启用。
 */
export async function detectNetIsolation(
    options: { nodePath?: string; platform?: NodeJS.Platform } = {},
): Promise<NetIsolation> {
    const node = options.nodePath ?? process.execPath;
    const platform = options.platform ?? process.platform;
    if (platform === 'linux') {
        const unshare = firstExisting(['/usr/bin/unshare', '/bin/unshare']);
        if (!unshare) return NONE;
        const wrap = (command: string, args: string[]) => ({
            command: unshare,
            args: ['--user', '--map-root-user', '--net', '--', command, ...args],
        });
        const check = `const i=require('node:os').networkInterfaces();process.exit(Object.values(i).flat().some(a=>a&&!a.internal)?1:0)`;
        const probe = wrap(node, ['-e', check]);
        return (await runProbe(probe.command, probe.args)) ? { kind: 'unshare', wrap } : NONE;
    }
    if (platform === 'darwin') {
        const sandbox = firstExisting(['/usr/bin/sandbox-exec']);
        if (!sandbox) return NONE;
        const wrap = (command: string, args: string[]) => ({
            command: sandbox,
            args: ['-p', SANDBOX_PROFILE, command, ...args],
        });
        const connect = (port: number) =>
            `const s=require('node:net').connect(${port},'127.0.0.1');s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(2),5000)`;
        const ok = await sandboxDeniesConnect(sandbox, (port) => wrap(node, ['-e', connect(port)]).args);
        return ok ? { kind: 'sandbox-exec', wrap } : NONE;
    }
    return NONE;
}

export const NO_NET_ISOLATION = NONE;
