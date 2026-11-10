// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// Anthropic Messages API 原生适配(ADR 0006 第 5 节):只用 fetch,不引入 SDK。
// 流式事件:message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop。
import type { ModelTestResult, Usage } from '@fatcat-ai/shared';
import {
    createHttp,
    guardedStream,
    listModels,
    parseData,
    parseToolArgs,
    runConnectionTest,
    sseData,
    toWireToolName,
} from './http.js';
import { type Redactor, sanitizeUpstreamText } from './redact.js';
import {
    type ChatChunk,
    type ChatMessage,
    type ChatRequest,
    type FinishReason,
    type ModelProvider,
    ProviderError,
    type ProviderProfile,
} from './types.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';
/** Messages API 要求 max_tokens;配置档没给时用这个值。 */
const DEFAULT_MAX_TOKENS = 4096;

export interface NativeProviderOptions {
    profile: ProviderProfile;
    /** 每次请求时取密钥明文。 */
    getApiKey: () => string | null;
    redactor: Redactor;
    fetch?: typeof fetch | undefined;
    firstTokenTimeoutMs?: number | undefined;
    testTimeoutMs?: number | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
    now?: (() => number) | undefined;
}

type Block =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string };

interface WireMessage {
    role: 'user' | 'assistant';
    content: Block[];
}

/** system 消息合并到顶层 system;tool 结果作为 user 消息里的 tool_result;相邻同角色消息合并(API 要求交替)。 */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: WireMessage[] } {
    const system: string[] = [];
    const out: WireMessage[] = [];
    const push = (role: WireMessage['role'], blocks: Block[]) => {
        if (blocks.length === 0) return;
        const last = out.at(-1);
        if (last?.role === role) last.content.push(...blocks);
        else out.push({ role, content: blocks });
    };
    for (const m of messages) {
        switch (m.role) {
            case 'system':
                system.push(m.content);
                break;
            case 'user':
                push('user', [{ type: 'text', text: m.content }]);
                break;
            case 'assistant': {
                const blocks: Block[] = m.content ? [{ type: 'text', text: m.content }] : [];
                for (const c of m.toolCalls ?? []) {
                    blocks.push({ type: 'tool_use', id: c.callId, name: toWireToolName(c.name), input: c.input ?? {} });
                }
                push('assistant', blocks);
                break;
            }
            case 'tool':
                push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]);
                break;
        }
    }
    return { system: system.join('\n\n'), messages: out };
}

function mapStop(reason: unknown): FinishReason | null {
    switch (reason) {
        case 'end_turn':
        case 'stop_sequence':
            return 'stop';
        case 'max_tokens':
            return 'length';
        case 'tool_use':
            return 'tool-calls';
        default:
            return reason ? 'stop' : null;
    }
}

const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

interface StreamEvent {
    type: string;
    index?: number;
    message?: { usage?: { input_tokens?: unknown } };
    content_block?: { type: string; id?: string; name?: string; text?: string };
    delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
    usage?: { output_tokens?: unknown };
    error?: { type?: string; message?: string };
}

export function createAnthropicProvider(options: NativeProviderOptions): ModelProvider {
    const { profile, redactor } = options;
    const http = createHttp({ redactor, fetch: options.fetch, sleep: options.sleep });
    const now = options.now ?? Date.now;
    const base = (profile.baseURL ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '');

    function headers(): Record<string, string> {
        const h: Record<string, string> = {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'anthropic-version': ANTHROPIC_VERSION,
        };
        const key = options.getApiKey();
        if (key) h['x-api-key'] = key;
        return h;
    }

    function stream(request: ChatRequest): AsyncGenerator<ChatChunk> {
        const { system, messages } = toAnthropicMessages(request.messages);
        const body: Record<string, unknown> = {
            model: profile.model,
            max_tokens: profile.params?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
            messages,
            stream: true,
        };
        if (system) body.system = system;
        // Anthropic 的 temperature 范围是 0–1,配置档允许到 2,超出部分截断
        if (profile.params?.temperature !== undefined) body.temperature = Math.min(profile.params.temperature, 1);
        const toolNames = new Map<string, string>();
        if (request.tools?.length) {
            body.tools = request.tools.map((t) => {
                const wire = toWireToolName(t.name);
                toolNames.set(wire, t.name);
                return { name: wire, description: t.description, input_schema: t.parameters };
            });
        }

        return guardedStream(request, http, options.firstTokenTimeoutMs ?? 60_000, async function* (signal, gotData) {
            const tools = new Map<number, { id: string; name: string; args: string }>();
            let finish: FinishReason | null = null;
            let inputTokens: number | undefined;
            let outputTokens: number | undefined;

            const res = await http.post(`${base}/messages`, headers(), body, signal);
            if (!res.body) throw new ProviderError('upstream_error', 'upstream returned an empty body');
            for await (const data of sseData(res.body)) {
                gotData();
                const e = parseData<StreamEvent>(data);
                switch (e.type) {
                    case 'message_start':
                        inputTokens = count(e.message?.usage?.input_tokens) ?? inputTokens;
                        break;
                    case 'content_block_start':
                        if (e.content_block?.type === 'tool_use') {
                            tools.set(e.index ?? tools.size, {
                                id: e.content_block.id ?? '',
                                name: e.content_block.name ?? '',
                                args: '',
                            });
                        } else if (e.content_block?.type === 'text' && e.content_block.text) {
                            yield { type: 'text-delta', delta: e.content_block.text };
                        }
                        break;
                    case 'content_block_delta':
                        if (e.delta?.type === 'text_delta' && e.delta.text) {
                            yield { type: 'text-delta', delta: e.delta.text };
                        } else if (e.delta?.type === 'input_json_delta') {
                            const tool = tools.get(e.index ?? -1);
                            if (tool) tool.args += e.delta.partial_json ?? '';
                        }
                        break;
                    case 'message_delta':
                        finish = mapStop(e.delta?.stop_reason) ?? finish;
                        outputTokens = count(e.usage?.output_tokens) ?? outputTokens;
                        break;
                    case 'error':
                        throw new ProviderError(
                            'upstream_error',
                            `upstream error: ${sanitizeUpstreamText(redactor, e.error?.message ?? 'unknown')}`,
                        );
                    default:
                        // ping、content_block_stop、message_stop 与未知事件:忽略
                        break;
                }
            }

            for (const [index, call] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
                yield {
                    type: 'tool-call',
                    callId: call.id || `call_${index}`,
                    name: toolNames.get(call.name) ?? call.name,
                    input: parseToolArgs(call.args, call.name || String(index)),
                };
            }
            const usage: Usage = {};
            if (inputTokens !== undefined) usage.inputTokens = inputTokens;
            if (outputTokens !== undefined) usage.outputTokens = outputTokens;
            if (inputTokens !== undefined && outputTokens !== undefined) usage.totalTokens = inputTokens + outputTokens;
            yield {
                type: 'finish',
                reason: finish ?? (tools.size > 0 ? 'tool-calls' : 'stop'),
                ...(Object.keys(usage).length > 0 ? { usage } : {}),
            };
        });
    }

    function test(signal?: AbortSignal): Promise<ModelTestResult> {
        const testOptions = {
            apiKeyRef: profile.apiKeyRef,
            getApiKey: options.getApiKey,
            timeoutMs: options.testTimeoutMs ?? 15_000,
            now,
        };
        return runConnectionTest(http, testOptions, signal, (s) => {
            const h = headers();
            delete h.accept;
            return listModels(http, `${base}/models?limit=100`, h, s, now(), now, (json) =>
                ((json as { data?: { id?: unknown }[] } | null)?.data ?? []).map((m) => m.id),
            );
        });
    }

    return { profileId: profile.id, stream, test };
}
