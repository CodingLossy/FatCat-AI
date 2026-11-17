// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 动作 agent_prompt(ADR 0034):把提示词交给 Agent,在新的任务会话里无人值守地运行。
// 工具审批照旧:没人批就过期 = 拒绝,运行记为 blocked 的同类错误码,不重试。
import type { RunManager } from '@fatcat-ai/agent';
import type { Repositories } from '@fatcat-ai/storage';
import { resolveProfile } from '../routes/sessions.js';
import { ExecutorError, type Executor } from './engine.js';

export interface AgentTaskDeps {
    repos: Repositories;
    runs: RunManager;
    resolveProfile: typeof resolveProfile;
    secrets: Parameters<typeof resolveProfile>[0]['secrets'];
    now?: () => Date;
}

/** 提示词前的固定说明:告诉模型这是无人值守的任务,以及怎样输出。说明由 core 生成,不含任何用户或外部内容。 */
function wrap(prompt: string, channelOutput: boolean): string {
    return [
        '[Scheduled task, unattended] The owner is not present. Do the task below. Anything that needs approval will wait for the owner and expire if nobody answers; do not retry it in a loop.',
        channelOutput
            ? 'When the result is ready, send it once with the channel.push tool (one message), then stop.'
            : 'Write the result as your final answer.',
        'Task:',
        prompt,
    ].join('\n');
}

export function createAgentTaskExecutor(deps: AgentTaskDeps): Executor {
    const { repos, runs } = deps;
    return async ({ task, run, signal }) => {
        if (task.action.kind !== 'agent_prompt') throw new ExecutorError('config_error');
        let profile;
        try {
            profile = deps.resolveProfile({ repos, secrets: deps.secrets }, task.ownerId, null, null);
        } catch {
            throw new ExecutorError('config_error');
        }
        const channel = task.outputs.find((o) => o.kind === 'channel');
        if (channel) {
            const record = repos.channels.get(task.ownerId, channel.channelId);
            if (!record?.enabled || !record.binding) throw new ExecutorError('config_error');
        }
        const session = repos.sessions.create(task.ownerId, { title: task.name });
        const started = runs.start({
            ownerId: task.ownerId,
            sessionId: session.id,
            profile,
            text: wrap(task.action.prompt, channel !== undefined),
            task: {
                id: task.id,
                channelId: channel?.channelId,
                allowedTools: (task.policy.allowedTools ?? []).map((a) => ({
                    tool: a.tool,
                    ...(a.constraint ? { constraint: a.constraint } : {}),
                })),
            },
        });
        repos.tasks.setRunSession(run.id, session.id, started.runId);
        const onAbort = () => runs.cancel(started.runId);
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            const status = await waitForRun(repos, task.ownerId, started.runId, signal);
            if (status === 'cancelled') throw new ExecutorError('cancelled');
            if (status !== 'succeeded') throw new ExecutorError('model_error', true);
            // 审批没有通过(被拒绝或到期)时,运行本身仍会「成功」结束:按审批状态记成相应错误码,不重试
            const approvals = repos.approvals
                .list(task.ownerId, { limit: 50 })
                .items.filter((a) => a.runId === started.runId);
            if (approvals.some((a) => a.status === 'rejected')) throw new ExecutorError('approval_rejected');
            if (approvals.some((a) => a.status === 'expired')) throw new ExecutorError('approval_expired');
            if (channel && !approvals.some((a) => a.toolName === 'channel.push' && a.status === 'approved')) {
                throw new ExecutorError('output_failed');
            }
            return 'succeeded';
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    };
}

function waitForRun(repos: Repositories, ownerId: string, runId: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
        const check = () => {
            const status = repos.runs.get(ownerId, runId)?.status;
            if (status && status !== 'running' && status !== 'queued' && status !== 'waiting_approval') {
                clearInterval(timer);
                resolve(signal.aborted ? 'cancelled' : status);
            }
        };
        const timer = setInterval(check, 500);
        timer.unref?.();
        check();
    });
}
