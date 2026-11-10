// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { AipClient } from '@ai-personal/client';
import { connect, parse, resolveModelId } from '../common.js';
import { type Ctx, isInteractive, lineReader, readAll, status, UsageError } from '../io.js';
import { approverFor, runTurn, type TurnResult } from '../turn.js';

const exitCode = (r: TurnResult) => (r.outcome === 'finished' ? 0 : r.outcome === 'cancelled' ? 130 : 1);

const titleOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 60);

async function newSession(client: AipClient, text: string, modelId: string | undefined) {
    return client.sessions.create({ title: titleOf(text), ...(modelId ? { modelProfileId: modelId } : {}) });
}

/** ai-personal ask:单次提问,适合脚本。 */
export async function askCommand(ctx: Ctx, args: string[]): Promise<number> {
    const { values, positionals } = parse(args, {
        stdin: { type: 'boolean' },
        json: { type: 'boolean' },
        session: { type: 'string', short: 's' },
        model: { type: 'string', short: 'm' },
        'approve-tools': { type: 'boolean' },
    });
    const parts = [positionals.join(' ').trim()];
    if (values.stdin) parts.push((await readAll(ctx)).trim());
    const text = parts.filter(Boolean).join('\n\n');
    if (!text) throw new UsageError('Usage: ai-personal ask "question" (or --stdin)');

    const { client } = connect(ctx, values.server);
    const modelId = await resolveModelId(client, values.model);
    let sessionId = values.session;
    if (!sessionId) {
        sessionId = (await newSession(client, text, modelId)).id;
        status(ctx, `(session ${sessionId})`);
    }
    // 从 stdin 读题时 stdin 已被占用,不再交互询问审批
    const approve = approverFor(ctx, {
        autoApprove: values['approve-tools'] ?? false,
        interactive: isInteractive(ctx) && !values.stdin,
        rl: null,
    });
    const id = sessionId;
    const result = await runTurn(
        ctx,
        client,
        (signal) => client.sessions.send(id, { text, ...(modelId ? { modelProfileId: modelId } : {}) }, { signal }),
        { json: values.json ?? false, approve },
    );
    return exitCode(result);
}

const CHAT_HELP = `Commands: /new  new session · /model <id|label>  switch profile · /retry  regenerate · /exit`;

/** ai-personal chat:交互式聊天。 */
export async function chatCommand(ctx: Ctx, args: string[]): Promise<number> {
    const { values } = parse(args, {
        session: { type: 'string', short: 's' },
        model: { type: 'string', short: 'm' },
        'approve-tools': { type: 'boolean' },
    });
    const { client, config } = connect(ctx, values.server);
    let modelId = await resolveModelId(client, values.model);
    let sessionId = values.session ?? null;
    if (sessionId) await client.sessions.get(sessionId);
    let lastAssistant: string | null = null;

    const interactive = isInteractive(ctx);
    const rl = lineReader(ctx);
    // 终端模式下 Ctrl+C 由 readline 捕获:运行中交给 runTurn(取消运行),空闲时提示,再按一次退出
    let turnInterrupt: (() => void) | null = null;
    let idleInterrupts = 0;
    rl.on('SIGINT', () => {
        if (turnInterrupt) return turnInterrupt();
        idleInterrupts += 1;
        if (idleInterrupts >= 2) return rl.close();
        status(ctx, '\n(press Ctrl+C again or type /exit to quit)');
        rl.prompt();
    });
    const turnCtx: Ctx = {
        ...ctx,
        onInterrupt: (handler) => {
            turnInterrupt = handler;
            const offProcess = ctx.onInterrupt(handler);
            return () => {
                turnInterrupt = null;
                offProcess();
            };
        },
    };
    const approve = approverFor(ctx, { autoApprove: values['approve-tools'] ?? false, interactive, rl });
    const prompt = () => {
        if (interactive) rl.prompt();
    };

    if (interactive) status(ctx, `Connected to ${config.server}. ${CHAT_HELP}`);
    rl.setPrompt('> ');
    prompt();

    let code = 0;
    for await (const raw of rl) {
        idleInterrupts = 0;
        const line = raw.trim();
        if (!line) {
            prompt();
            continue;
        }
        try {
            if (line === '/exit' || line === '/quit') break;
            if (line === '/help') {
                status(ctx, CHAT_HELP);
            } else if (line === '/new') {
                sessionId = null;
                lastAssistant = null;
                status(ctx, '(new session)');
            } else if (line.startsWith('/model')) {
                const ref = line.slice('/model'.length).trim();
                if (!ref) throw new UsageError('Usage: /model <id|label>');
                modelId = await resolveModelId(client, ref);
                if (sessionId) await client.sessions.update(sessionId, { modelProfileId: modelId ?? null });
                status(ctx, `(model ${ref})`);
            } else if (line === '/retry') {
                if (!sessionId || !lastAssistant) throw new UsageError('Nothing to retry yet');
                const sid = sessionId;
                const mid = lastAssistant;
                const result = await runTurn(
                    turnCtx,
                    client,
                    (signal) => client.sessions.regenerate(sid, mid, { signal }),
                    { json: false, approve },
                );
                lastAssistant = result.assistantMessageId ?? lastAssistant;
                code = exitCode(result) === 1 ? 1 : 0;
            } else if (line.startsWith('/')) {
                throw new UsageError(`Unknown command ${line.split(' ')[0]}. ${CHAT_HELP}`);
            } else {
                if (!sessionId) {
                    sessionId = (await newSession(client, line, modelId)).id;
                    status(ctx, `(session ${sessionId})`);
                }
                const sid = sessionId;
                const result = await runTurn(
                    turnCtx,
                    client,
                    (signal) => client.sessions.send(sid, { text: line }, { signal }),
                    { json: false, approve },
                );
                lastAssistant = result.assistantMessageId ?? lastAssistant;
                code = exitCode(result) === 1 ? 1 : 0;
            }
        } catch (error) {
            status(ctx, `error: ${(error as Error).message}`);
            code = 1;
        }
        prompt();
    }
    rl.close();
    return interactive ? 0 : code;
}
