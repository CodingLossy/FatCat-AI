// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { hostname } from 'node:os';
import { FatCatApiError } from '@fatcat-ai/client';
import { connect, parse } from '../common.js';
import { readConfigFile, removeConfigFile, writeConfigFile } from '../config.js';
import { type Ctx, promptLine, readAll, readHidden, status, UsageError } from '../io.js';

const credentialOptions = {
    username: { type: 'string', short: 'u' },
    'password-stdin': { type: 'boolean' },
    'token-name': { type: 'string' },
    'setup-code': { type: 'string' },
} as const;

async function readCredentials(ctx: Ctx, values: { username?: string; 'password-stdin'?: boolean }) {
    const username = values.username ?? (await promptLine(ctx, 'Username: '));
    // 密码不接受命令行参数(会留在 shell 历史与进程列表里)
    const password = values['password-stdin']
        ? (await readAll(ctx)).replace(/\r?\n$/, '')
        : await readHidden(ctx, 'Password: ');
    if (!username || !password) throw new UsageError('Username and password are required');
    return { username, password };
}

const defaultTokenName = () => `cli@${hostname()}`.slice(0, 60);

/** setup / login 共用:换到令牌后只把令牌写进配置文件。 */
async function signIn(ctx: Ctx, args: string[], mode: 'setup' | 'login'): Promise<number> {
    const { values } = parse(args, credentialOptions);
    const setupCode = values['setup-code'];
    if (mode === 'login' && setupCode !== undefined) throw new UsageError('--setup-code is only for "setup"');
    const { client, config } = connect(ctx, values.server, false);
    const credentials = await readCredentials(ctx, values);
    const tokenName = values['token-name'] ?? defaultTokenName();
    const result =
        mode === 'setup'
            ? await client.auth.setupForToken({ ...credentials, ...(setupCode ? { setupCode } : {}), tokenName })
            : await client.auth.loginForToken({ ...credentials, tokenName });
    writeConfigFile(config.path, { server: config.server, token: result.token.token, tokenId: result.token.id });
    status(
        ctx,
        `${mode === 'setup' ? 'Created owner' : 'Signed in as'} ${result.owner.username} on ${config.server}; ` +
            `token "${result.token.name}" saved to ${config.path}`,
    );
    return 0;
}

export const setup = (ctx: Ctx, args: string[]) => signIn(ctx, args, 'setup');
export const login = (ctx: Ctx, args: string[]) => signIn(ctx, args, 'login');

export async function logout(ctx: Ctx, args: string[]): Promise<number> {
    const { values } = parse(args, {});
    const { client, config } = connect(ctx, values.server);
    if (config.tokenSource === 'env') {
        throw new UsageError('The token comes from FATCAT_AI_TOKEN; unset it instead (it was not revoked).');
    }
    const file = readConfigFile(config.path);
    if (file.tokenId) {
        try {
            await client.tokens.revoke(file.tokenId);
        } catch (error) {
            // 令牌已失效或已被吊销时仍然删除本地配置
            if (!(error instanceof FatCatApiError) || (error.status !== 401 && error.status !== 404)) throw error;
        }
    }
    removeConfigFile(config.path);
    status(ctx, `Signed out of ${config.server}`);
    return 0;
}

export async function whoami(ctx: Ctx, args: string[]): Promise<number> {
    const { values } = parse(args, {});
    const { client, config } = connect(ctx, values.server);
    const me = await client.auth.me();
    ctx.stdout.write(`${me.username} @ ${config.server}\n`);
    return 0;
}

export async function approve(ctx: Ctx, args: string[]): Promise<number> {
    const { values, positionals } = parse(args, { reject: { type: 'boolean' } });
    const callId = positionals[0];
    if (!callId) throw new UsageError('Usage: fatcat-ai approve <callId> [--reject]');
    const { client } = connect(ctx, values.server);
    const result = await client.approvals.decide(callId, values.reject ? 'reject' : 'approve');
    status(ctx, `${result.callId}: ${result.decision}d`);
    return 0;
}
