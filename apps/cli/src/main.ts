// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { readFileSync } from 'node:fs';
import { FatCatApiError, FatCatNetworkError } from '@fatcat-ai/client';
import { applyLegacyEnv, legacyEnvWarning } from '@fatcat-ai/shared';
import { approve, login, logout, setup, whoami } from './commands/auth.js';
import { askCommand, chatCommand } from './commands/chat.js';
import { memoryCommand } from './commands/memory.js';
import { modelsCommand } from './commands/models.js';
import { serveCommand } from './commands/serve.js';
import { sessionsCommand } from './commands/sessions.js';
import { CLI_ENV_NAMES } from './config.js';
import { type Ctx, status, UsageError } from './io.js';

export const HELP = `fatcat-ai: command-line client for a FatCat-AI server

Usage: fatcat-ai <command> [options]

Account
  setup [-u name] [--password-stdin] [--setup-code code]   create the owner account (first run) and sign in
  login [-u name] [--password-stdin]                        sign in; saves a personal access token
  logout                                                    revoke the saved token
  whoami                                                    show the signed-in owner

Chat
  chat [-s session] [-m model] [--approve-tools]            interactive chat (/new /model /retry /exit)
  ask "text" [--stdin] [--json] [-s session] [-m model] [--approve-tools]
                                                            one-shot question; reply on stdout
  approve <callId> [--reject]                               answer a pending tool approval

Data
  sessions list [--limit n] [--json] | sessions show <id> [--json]
  models list [--json] | models add ... | models test <id|label>
  memory list [--json] | memory search <query> | memory add <text> | memory edit <id> <text> | memory forget <id>

Server
  serve [--host h] [--port p] [--data-dir dir]              run the core server in this process

Global options
  --server <url>   server address (default: FATCAT_AI_SERVER, then the saved one, then http://127.0.0.1:8787)
  -h, --help       show help;  -v, --version  show the version

The token is read from FATCAT_AI_TOKEN or the saved config (FATCAT_AI_CLI_CONFIG, default ~/.fatcat-ai/cli.json).
Tool calls that need approval are asked about in a terminal and rejected otherwise, unless --approve-tools.
`;

type Command = (ctx: Ctx, args: string[]) => Promise<number>;

const COMMANDS: Record<string, Command> = {
    setup,
    login,
    logout,
    whoami,
    approve,
    ask: askCommand,
    chat: chatCommand,
    sessions: sessionsCommand,
    models: modelsCommand,
    memory: memoryCommand,
    serve: serveCommand,
};

function version(): string {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    return pkg.version;
}

/** 运行一条命令,返回退出码:0 成功,1 失败,2 用法错误,130 被中断。 */
export async function main(argv: string[], ctx: Ctx): Promise<number> {
    const [name, ...args] = argv;
    if (!name || name === '-h' || name === '--help' || name === 'help') {
        ctx.stdout.write(HELP);
        return name ? 0 : 2;
    }
    if (name === '-v' || name === '--version') {
        ctx.stdout.write(`${version()}\n`);
        return 0;
    }
    const command = COMMANDS[name];
    if (!command) {
        status(ctx, `Unknown command "${name}". Run "fatcat-ai --help".`);
        return 2;
    }
    if (args.includes('--help') || args.includes('-h')) {
        ctx.stdout.write(HELP);
        return 0;
    }
    // 改名前的 AIP_* 环境变量暂时兼容读取(ADR 0019)
    const legacy = applyLegacyEnv(ctx.env, CLI_ENV_NAMES);
    if (legacy.length > 0) status(ctx, `warning: ${legacyEnvWarning(legacy)}`);
    try {
        return await command(ctx, args);
    } catch (error) {
        if (error instanceof UsageError) {
            status(ctx, error.message);
            return 2;
        }
        if (error instanceof FatCatApiError) {
            const hint = error.status === 401 ? ' (run "fatcat-ai login")' : '';
            status(ctx, `error: ${error.message}${hint}`);
            return 1;
        }
        if (error instanceof FatCatNetworkError) {
            status(ctx, `error: ${error.message}`);
            return 1;
        }
        throw error;
    }
}
