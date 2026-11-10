// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// Gemini(Generative Language API)原生适配(ADR 0006 第 5 节):只用 fetch,不引入 SDK。
// 流式:POST models/{model}:streamGenerateContent?alt=sse;密钥放 x-goog-api-key 头,不放 URL(URL 会进日志)。
import type { ModelTestResult, Usage } from '@ai-personal/shared';
import type { NativeProviderOptions } from './anthropic.js';
import {
    createHttp,
    guardedStream,
    listModels,
    parseData,
    runConnectionTest,
    sseData,
    toWireToolName,
} from './http.js';
import { sanitizeUpstreamText } from './redact.js';
import {
    type ChatChunk,
    type ChatMessage,
    type ChatRequest,
    type FinishReason,
    type ModelProvider,
    ProviderError,
} from './types.js';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

type Part =
    | { text: string }
    | { functionCall: { name: string; args: unknown } }
    | { functionResponse: { name: string; response: Record<string, unknown> } };

interface Content {
    role: 'user' | 'model';
    parts: Part[];
}

function parseMaybeJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

/** system → systemInstruction;assistant → model;tool 结果 → user 中的 functionResponse(按 callId 找回函数名)。 */
export function toGeminiContents(messages: ChatMessage[]): { system: string; contents: Content[] } {
    const system: string[] = [];
    const contents: Content[] = [];
    const names = new Map<string, string>();
    const push = (role: Content['role'], parts: Part[]) => {
        if (parts.length === 0) return;
        const last = contents.at(-1);
        if (last?.role === role) last.parts.push(...parts);
        else contents.push({ role, parts });
    };
    for (const m of messages) {
        switch (m.role) {
            case 'system':
                system.push(m.content);
                break;
            case 'user':
                push('user', [{ text: m.content }]);
                break;
            case 'assistant': {
                const parts: Part[] = m.content ? [{ text: m.content }] : [];
                for (const c of m.toolCalls ?? []) {
                    const name = toWireToolName(c.name);
                    names.set(c.callId, name);
                    parts.push({ functionCall: { name, args: c.input ?? {} } });
                }
                push('model', parts);
                break;
            }
            case 'tool':
                push('user', [
                    {
                        functionResponse: {
                            name: names.get(m.toolCallId) ?? 'unknown',
                            response: { result: parseMaybeJson(m.content) },
                        },
                    },
                ]);
                break;
        }
    }
    return { system: system.join('\n\n'), contents };
}

const SCHEMA_KEYS = new Set([
    'type',
    'description',
    'properties',
    'required',
    'items',
    'enum',
    'format',
    'nullable',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'anyOf',
]);

/**
 * Gemini 的 functionDeclarations 只接受 OpenAPI Schema 的一个子集:去掉 $schema、additionalProperties 等不支持的键,
 * 类型改为大写,["string", "null"] 这类写法改为 type + nullable。
 */
export function toGeminiSchema(schema: unknown): unknown {
    if (Array.isArray(schema)) return schema.map(toGeminiSchema);
    if (!schema || typeof schema !== 'object') return schema;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        if (!SCHEMA_KEYS.has(key)) continue;
        if (key === 'type') {
            const types = (Array.isArray(value) ? value : [value]).filter((t): t is string => typeof t === 'string');
            const main = types.find((t) => t !== 'null');
            if (main) out.type = main.toUpperCase();
            if (types.includes('null')) out.nullable = true;
        } else if (key === 'properties' && value && typeof value === 'object') {
            out.properties = Object.fromEntries(
                Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toGeminiSchema(v)]),
            );
        } else if (key === 'items' || key === 'anyOf') {
            out[key] = toGeminiSchema(value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function mapFinish(reason: unknown): FinishReason | null {
    if (reason === 'MAX_TOKENS') return 'length';
    return typeof reason === 'string' && reason !== 'FINISH_REASON_UNSPECIFIED' ? 'stop' : null;
}

/** 无效密钥时 Gemini 返回 400 INVALID_ARGUMENT,这里归为 auth_failed。 */
function classifyGemini(status: number, body: string): 'auth_failed' | undefined {
    return status === 400 && /API_KEY_INVALID|API key not valid/i.test(body) ? 'auth_failed' : undefined;
}

const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

interface StreamResponse {
    candidates?: {
        content?: {
            parts?: {
                text?: string;
                thought?: boolean;
                functionCall?: { id?: string; name?: string; args?: unknown };
            }[];
        };
        finishReason?: string;
    }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; totalTokenCount?: unknown };
    error?: { message?: string };
}

export function createGeminiProvider(options: NativeProviderOptions): ModelProvider {
    const { profile, redactor } = options;
    const http = createHttp({ redactor, fetch: options.fetch, sleep: options.sleep, classify: classifyGemini });
    const now = options.now ?? Date.now;
    const base = (profile.baseURL ?? GEMINI_BASE_URL).replace(/\/+$/, '');
    const model = profile.model.replace(/^models\//, '');

    function headers(): Record<string, string> {
        const h: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
        const key = options.getApiKey();
        if (key) h['x-goog-api-key'] = key;
        return h;
    }

    function stream(request: ChatRequest): AsyncGenerator<ChatChunk> {
        const { system, contents } = toGeminiContents(request.messages);
        const body: Record<string, unknown> = { contents };
        if (system) body.systemInstruction = { parts: [{ text: system }] };
        const generationConfig: Record<string, unknown> = {};
        if (profile.params?.temperature !== undefined) generationConfig.temperature = profile.params.temperature;
        if (profile.params?.maxOutputTokens !== undefined)
            generationConfig.maxOutputTokens = profile.params.maxOutputTokens;
        if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
        const toolNames = new Map<string, string>();
        if (request.tools?.length) {
            body.tools = [
                {
                    functionDeclarations: request.tools.map((t) => {
                        const wire = toWireToolName(t.name);
                        toolNames.set(wire, t.name);
                        return { name: wire, description: t.description, parameters: toGeminiSchema(t.parameters) };
                    }),
                },
            ];
        }
        const url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

        return guardedStream(request, http, options.firstTokenTimeoutMs ?? 60_000, async function* (signal, gotData) {
            let finish: FinishReason | null = null;
            let usage: Usage | undefined;
            let calls = 0;

            const res = await http.post(url, headers(), body, signal);
            if (!res.body) throw new ProviderError('upstream_error', 'upstream returned an empty body');
            for await (const data of sseData(res.body)) {
                gotData();
                const json = parseData<StreamResponse>(data);
                if (json.error) {
                    throw new ProviderError(
                        'upstream_error',
                        `upstream error: ${sanitizeUpstreamText(redactor, json.error.message ?? 'unknown')}`,
                    );
                }
                if (json.promptFeedback?.blockReason) {
                    throw new ProviderError(
                        'bad_request',
                        `the prompt was blocked: ${json.promptFeedback.blockReason}`,
                    );
                }
                const meta = json.usageMetadata;
                if (meta) {
                    const u: Usage = {};
                    const input = count(meta.promptTokenCount);
                    const output = count(meta.candidatesTokenCount);
                    const total = count(meta.totalTokenCount);
                    if (input !== undefined) u.inputTokens = input;
                    if (output !== undefined) u.outputTokens = output;
                    if (total !== undefined) u.totalTokens = total;
                    if (Object.keys(u).length > 0) usage = u;
                }
                const candidate = json.candidates?.[0];
                if (!candidate) continue;
                for (const part of candidate.content?.parts ?? []) {
                    if (part.thought) continue;
                    if (typeof part.text === 'string' && part.text.length > 0) {
                        yield { type: 'text-delta', delta: part.text };
                    } else if (part.functionCall?.name) {
                        const index = calls++;
                        yield {
                            type: 'tool-call',
                            callId: part.functionCall.id || `call_${index}`,
                            name: toolNames.get(part.functionCall.name) ?? part.functionCall.name,
                            input: part.functionCall.args ?? {},
                        };
                    }
                }
                finish = mapFinish(candidate.finishReason) ?? finish;
            }
            yield {
                type: 'finish',
                // Gemini 调用函数时 finishReason 仍是 STOP
                reason: calls > 0 ? 'tool-calls' : (finish ?? 'stop'),
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
        return runConnectionTest(http, testOptions, signal, (s) => {
            const h = headers();
            delete h.accept;
            return listModels(http, `${base}/models?pageSize=100`, h, s, now(), now, (json) =>
                ((json as { models?: { name?: unknown }[] } | null)?.models ?? []).map((m) =>
                    typeof m.name === 'string' ? m.name.replace(/^models\//, '') : m.name,
                ),
            );
        });
    }

    return { profileId: profile.id, stream, test };
}
