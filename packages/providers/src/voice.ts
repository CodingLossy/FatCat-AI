// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// OpenAI 兼容的语音接口:/audio/transcriptions 与 /audio/speech(ADR 0021)。只用 fetch 与 FormData;
// 音频不写日志,朗读的音频逐块转发,不在内存里攒整段。
import { type AudioMediaType, DEFAULT_VOICE_PROTOCOL, type SpeechFormat, type VoiceProtocol } from '@fatcat-ai/shared';
import { createHttp } from './http.js';
import type { Redactor } from './redact.js';
import { ProviderError, type ProviderProfile } from './types.js';

/** 省略 params.voice 时使用的音色(OpenAI 的默认音色名)。 */
export const DEFAULT_TTS_VOICE = 'alloy';

const EXTENSIONS: Record<AudioMediaType, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
};

export interface VoiceClientOptions {
    profile: ProviderProfile;
    getApiKey: () => string | null;
    redactor: Redactor;
    fetch?: typeof fetch | undefined;
    /** 转写整体超时,默认 60 秒。 */
    transcribeTimeoutMs?: number | undefined;
    /** 朗读首字节超时,默认 15 秒。 */
    speechFirstByteTimeoutMs?: number | undefined;
    /** 朗读两块数据之间的超时,默认 30 秒。 */
    speechIdleTimeoutMs?: number | undefined;
}

export interface TranscribeRequest {
    audio: Uint8Array;
    mediaType: AudioMediaType;
    language?: string | undefined;
    signal?: AbortSignal | undefined;
}

export interface SpeakRequest {
    text: string;
    format: SpeechFormat;
    signal?: AbortSignal | undefined;
}

export interface VoiceClient {
    /** 返回去掉首尾空白的转写文字;上游错误以 ProviderError 抛出(已脱敏)。 */
    transcribe(request: TranscribeRequest): Promise<string>;
    /** 收到首块音频后返回音频流;之后的错误与超时让流出错并中止上游请求。 */
    speak(request: SpeakRequest): Promise<ReadableStream<Uint8Array>>;
}

/** 把调用方的中断与内部超时合成一个 AbortController;timedOut() 区分两者。 */
function abortScope(signal: AbortSignal | undefined) {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        arm(ms: number) {
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort(new Error('timeout'));
            }, ms);
        },
        disarm() {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
        },
        abort() {
            controller.abort();
        },
        dispose() {
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        },
    };
}

/**
 * 按配置档的 params.voiceProtocol 选择调用方式(ADR 0021 第 2 节)。目前只实现 openai;
 * 其他取值在配置档校验时已被拒绝,这里再兜底抛错,不会静默按 openai 调用别家的接口。
 */
export function createVoiceClient(options: VoiceClientOptions): VoiceClient {
    const protocol: VoiceProtocol = options.profile.params?.voiceProtocol ?? DEFAULT_VOICE_PROTOCOL;
    switch (protocol) {
        case 'openai':
            return openAIVoiceClient(options);
        case 'openai-chat':
        case 'volcengine':
            throw new Error(`voice protocol ${protocol} is not implemented yet`);
    }
}

/** OpenAI 的 /audio/transcriptions 与 /audio/speech。 */
function openAIVoiceClient(options: VoiceClientOptions): VoiceClient {
    const { profile } = options;
    if (profile.kind !== 'openai-compatible' || !profile.baseURL) {
        throw new Error('voice needs an openai-compatible profile with a baseURL');
    }
    const base = profile.baseURL.replace(/\/+$/, '');
    const http = createHttp({ redactor: options.redactor, fetch: options.fetch });
    const transcribeTimeoutMs = options.transcribeTimeoutMs ?? 60_000;
    const firstByteMs = options.speechFirstByteTimeoutMs ?? 15_000;
    const idleMs = options.speechIdleTimeoutMs ?? 30_000;

    function auth(): Record<string, string> {
        const key = options.getApiKey();
        return key ? { authorization: `Bearer ${key}` } : {};
    }

    function failure(error: unknown, scope: ReturnType<typeof abortScope>, ms: number): unknown {
        if (scope.timedOut()) return new ProviderError('timeout', `no response within ${ms} ms`);
        if (error instanceof ProviderError) return error;
        if (scope.signal.aborted) return error;
        return http.networkError(error);
    }

    return {
        async transcribe(request) {
            const scope = abortScope(request.signal);
            scope.arm(transcribeTimeoutMs);
            try {
                const form = new FormData();
                const blob = new Blob([request.audio as Uint8Array<ArrayBuffer>], { type: request.mediaType });
                form.append('file', blob, `audio.${EXTENSIONS[request.mediaType]}`);
                form.append('model', profile.model);
                form.append('response_format', 'json');
                if (request.language) form.append('language', request.language);
                const res = await http.fetch(`${base}/audio/transcriptions`, {
                    method: 'POST',
                    headers: auth(),
                    body: form,
                    signal: scope.signal,
                });
                if (!res.ok) throw await http.errorFrom(res);
                const json = (await res.json().catch(() => null)) as { text?: unknown } | null;
                if (typeof json?.text !== 'string') {
                    throw new ProviderError('upstream_error', 'upstream returned no transcription text');
                }
                return json.text.trim();
            } catch (error) {
                throw failure(error, scope, transcribeTimeoutMs);
            } finally {
                scope.dispose();
            }
        },

        async speak(request) {
            const scope = abortScope(request.signal);
            scope.arm(firstByteMs);
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            let first: Uint8Array | undefined;
            try {
                const res = await http.fetch(`${base}/audio/speech`, {
                    method: 'POST',
                    headers: { ...auth(), 'content-type': 'application/json' },
                    body: JSON.stringify({
                        model: profile.model,
                        input: request.text,
                        voice: profile.params?.voice ?? DEFAULT_TTS_VOICE,
                        response_format: request.format,
                    }),
                    signal: scope.signal,
                });
                if (!res.ok) throw await http.errorFrom(res);
                if (!res.body) throw new ProviderError('upstream_error', 'upstream returned no audio');
                reader = res.body.getReader();
                const chunk = await reader.read();
                if (chunk.done || chunk.value.length === 0) {
                    throw new ProviderError('upstream_error', 'upstream returned no audio');
                }
                first = chunk.value;
                scope.disarm();
            } catch (error) {
                scope.dispose();
                await reader?.cancel().catch(() => undefined);
                throw failure(error, scope, firstByteMs);
            }
            const upstream = reader;
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(first);
                },
                async pull(controller) {
                    // 只在等待上游时计时;客户端读得慢不算上游超时。
                    scope.arm(idleMs);
                    try {
                        const { value, done } = await upstream.read();
                        scope.disarm();
                        if (done) {
                            scope.dispose();
                            controller.close();
                            return;
                        }
                        controller.enqueue(value);
                    } catch (error) {
                        scope.dispose();
                        controller.error(failure(error, scope, idleMs));
                    }
                },
                async cancel() {
                    scope.abort();
                    scope.dispose();
                    await upstream.cancel().catch(() => undefined);
                },
            });
        },
    };
}
