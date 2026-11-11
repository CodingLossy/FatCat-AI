// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// OpenAI 兼容端点(OpenAI、DeepSeek、Ollama、LM Studio、vLLM 等)的流式实现。
// 只用 fetch 与 ReadableStream,不引入 SDK:AI SDK 7 加载即增加约 22 MiB RSS,而 2GB 机器的空闲预算只有 120 MiB(ADR 0006)。
import type { ModelTestResult, Usage } from '@fatcat-ai/shared';
import {
    createHttp,
    guardedStream,
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
    hasImage,
    type EmbedResult,
    type FinishReason,
    MAX_EMBED_BATCH,
    type ModelProvider,
    plainText,
    ProviderError,
    type ProviderProfile,
} from './types.js';

export { classifyStatus, toWireToolName } from './http.js';

export interface OpenAICompatibleOptions {
    profile: ProviderProfile;
    /** 每次请求时取密钥明文;返回 null 表示不带 Authorization。 */
    getApiKey: () => string | null;
    redactor: Redactor;
    fetch?: typeof fetch;
    /** 首个数据块的超时,默认 60 秒。 */
    firstTokenTimeoutMs?: number;
    /** 连接测试超时,默认 15 秒。 */
    testTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
    switch (m.role) {
        case 'assistant':
            return m.toolCalls?.length
                ? {
                      role: 'assistant',
                      content: m.content || null,
                      tool_calls: m.toolCalls.map((c) => ({
                          id: c.callId,
                          type: 'function',
                          function: { name: toWireToolName(c.name), arguments: JSON.stringify(c.input ?? {}) },
                      })),
                  }
                : { role: 'assistant', content: m.content };
        case 'tool':
            return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
        case 'user':
            if (!hasImage(m.content)) return { role: 'user', content: plainText(m.content) };
            return {
                role: 'user',
                content: m.content.map((p) =>
                    p.type === 'text'
                        ? { type: 'text', text: p.text }
                        : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } },
                ),
            };
        default:
            return { role: m.role, content: m.content };
    }
}

function mapFinish(reason: unknown): FinishReason | null {
    switch (reason) {
        case 'stop':
            return 'stop';
        case 'length':
            return 'length';
        case 'tool_calls':
        case 'function_call':
            return 'tool-calls';
        default:
            return reason === null || reason === undefined ? null : 'stop';
    }
}

function mapUsage(raw: unknown): Usage | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
    const usage: Usage = {};
    const input = n(u.prompt_tokens);
    const output = n(u.completion_tokens);
    const total = n(u.total_tokens);
    if (input !== undefined) usage.inputTokens = input;
    if (output !== undefined) usage.outputTokens = output;
    if (total !== undefined) usage.totalTokens = total;
    return Object.keys(usage).length > 0 ? usage : undefined;
}

interface PendingToolCall {
    id: string;
    name: string;
    args: string;
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): ModelProvider {
    const { profile, redactor } = options;
    const http = createHttp({ redactor, fetch: options.fetch, sleep: options.sleep });
    const now = options.now ?? Date.now;
    const firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? 60_000;
    if (!profile.baseURL) throw new ProviderError('bad_request', 'baseURL is required for openai-compatible profiles');
    const base = profile.baseURL.replace(/\/+$/, '');

    function headers(): Record<string, string> {
        const h: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
        const key = options.getApiKey();
        if (key) h.authorization = `Bearer ${key}`;
        return h;
    }

    function stream(request: ChatRequest): AsyncGenerator<ChatChunk> {
        const body: Record<string, unknown> = {
            model: profile.model,
            messages: request.messages.map(toWireMessage),
            stream: true,
            stream_options: { include_usage: true },
        };
        const toolNames = new Map<string, string>();
        if (request.tools?.length) {
            body.tools = request.tools.map((t) => {
                const wire = toWireToolName(t.name);
                toolNames.set(wire, t.name);
                return {
                    type: 'function',
                    function: { name: wire, description: t.description, parameters: t.parameters },
                };
            });
        }
        if (profile.params?.temperature !== undefined) body.temperature = profile.params.temperature;
        if (profile.params?.maxOutputTokens !== undefined) body.max_tokens = profile.params.maxOutputTokens;

        return guardedStream(request, http, firstTokenTimeoutMs, async function* (signal, gotData) {
            const pending = new Map<number, PendingToolCall>();
            let finish: FinishReason | null = null;
            let usage: Usage | undefined;

            const res = await http.post(`${base}/chat/completions`, headers(), body, signal);
            if (!res.body) throw new ProviderError('upstream_error', 'upstream returned an empty body');
            for await (const data of sseData(res.body)) {
                gotData();
                if (data.trim() === '[DONE]') break;
                const json = parseData<{
                    choices?: {
                        delta?: {
                            content?: string | null;
                            tool_calls?: {
                                index?: number;
                                id?: string;
                                function?: { name?: string; arguments?: string };
                            }[];
                        };
                        finish_reason?: string | null;
                    }[];
                    usage?: unknown;
                    error?: { message?: string };
                }>(data);
                if (json.error) {
                    throw new ProviderError(
                        'upstream_error',
                        `upstream error: ${sanitizeUpstreamText(redactor, json.error.message ?? 'unknown')}`,
                    );
                }
                usage = mapUsage(json.usage) ?? usage;
                const choice = json.choices?.[0];
                if (!choice) continue;
                const content = choice.delta?.content;
                if (typeof content === 'string' && content.length > 0) yield { type: 'text-delta', delta: content };
                for (const call of choice.delta?.tool_calls ?? []) {
                    const index = call.index ?? 0;
                    const entry = pending.get(index) ?? { id: '', name: '', args: '' };
                    if (call.id) entry.id = call.id;
                    if (call.function?.name) entry.name += call.function.name;
                    if (call.function?.arguments) entry.args += call.function.arguments;
                    pending.set(index, entry);
                }
                finish = mapFinish(choice.finish_reason) ?? finish;
            }

            for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
                yield {
                    type: 'tool-call',
                    callId: call.id || `call_${index}`,
                    name: toolNames.get(call.name) ?? call.name,
                    input: parseToolArgs(call.args, call.name || String(index)),
                };
            }
            yield {
                type: 'finish',
                reason: finish ?? (pending.size > 0 ? 'tool-calls' : 'stop'),
                ...(usage ? { usage } : {}),
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
        return runConnectionTest(http, testOptions, signal, async (s) => {
            const started = now();
            const res = await http.fetch(`${base}/models`, { headers: headers(), signal: s });
            if (res.ok) {
                const json = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
                const models = (json?.data ?? [])
                    .map((m) => m.id)
                    .filter((id): id is string => typeof id === 'string')
                    .slice(0, 100);
                return { ok: true, latencyMs: now() - started, models };
            }
            // 部分兼容端点没有 /models:退回一次最小的对话请求
            if (res.status === 404 || res.status === 405) {
                await res.body?.cancel().catch(() => undefined);
                const chat = await http.fetch(`${base}/chat/completions`, {
                    method: 'POST',
                    headers: headers(),
                    body: JSON.stringify({
                        model: profile.model,
                        messages: [{ role: 'user', content: 'ping' }],
                        max_tokens: 1,
                    }),
                    signal: s,
                });
                if (chat.ok) {
                    await chat.body?.cancel().catch(() => undefined);
                    return { ok: true, latencyMs: now() - started };
                }
                const err = await http.errorFrom(chat);
                return { ok: false, error: err.code, message: err.message };
            }
            const err = await http.errorFrom(res);
            return { ok: false, error: err.code, message: err.message };
        });
    }

    /** POST /embeddings(ADR 0014):按 index 排回输入顺序,校验条数与维度一致。 */
    async function embed(texts: string[], signal?: AbortSignal): Promise<EmbedResult> {
        if (texts.length === 0 || texts.length > MAX_EMBED_BATCH) {
            throw new ProviderError('bad_request', `embed accepts 1 to ${MAX_EMBED_BATCH} texts`);
        }
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), options.firstTokenTimeoutMs ?? 60_000);
        try {
            const res = await http.post(
                `${base}/embeddings`,
                headers(),
                { model: profile.model, input: texts, encoding_format: 'float' },
                controller.signal,
            );
            const json = (await res.json()) as {
                data?: { index?: unknown; embedding?: unknown }[];
                model?: unknown;
                usage?: unknown;
            };
            const vectors: Float32Array[] = new Array<Float32Array>(texts.length);
            for (const [i, row] of (json.data ?? []).entries()) {
                const index = typeof row.index === 'number' ? row.index : i;
                if (!Array.isArray(row.embedding) || index < 0 || index >= texts.length) continue;
                vectors[index] = Float32Array.from(row.embedding as number[]);
            }
            const dims = vectors[0]?.length ?? 0;
            for (let i = 0; i < texts.length; i++) {
                const v = vectors[i];
                if (!v || v.length === 0 || v.length !== dims || v.some((x) => !Number.isFinite(x))) {
                    throw new ProviderError('upstream_error', 'the embedding response is incomplete or malformed');
                }
            }
            const usage = mapUsage(json.usage);
            return {
                vectors,
                model: typeof json.model === 'string' && json.model ? json.model : profile.model,
                ...(usage ? { usage } : {}),
            };
        } catch (error) {
            if (error instanceof ProviderError) throw error;
            if (controller.signal.aborted && !signal?.aborted) {
                throw new ProviderError('timeout', 'the embedding request timed out');
            }
            throw http.networkError(error);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }

    return { profileId: profile.id, stream, test, embed };
}
