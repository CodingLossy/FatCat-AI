// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音转写与朗读(ADR 0021 第 3–5 节):服务器用配置档里的密钥调用 OpenAI 兼容端点,浏览器只拿到文字或音频流。
// 音频、转写文字与朗读文字都不写日志;日志只记配置档、字节数、字符数、耗时与状态码。
import { createRoute, z } from '@hono/zod-openapi';
import {
    Id,
    MAX_TRANSCRIPTION_BYTES,
    SPEECH_CONTENT_TYPES,
    SpeechRequest,
    sniffAudioType,
    TranscriptionResult,
} from '@fatcat-ai/shared';
import { createVoiceClient, ProviderError, type ProviderDeps, type VoiceClientOptions } from '@fatcat-ai/providers';
import type { ModelProfileRecord, Repositories } from '@fatcat-ai/storage';
import { requireOwner } from '../auth/middleware.js';
import { ApiError, notFound } from '../errors.js';
import type { WindowLimiter } from '../voice-limit.js';
import { authErrors, json, problem, router } from './common.js';

export interface VoiceRouteDeps {
    repos: Repositories;
    providerDeps: ProviderDeps;
    /** 每个用户每分钟的转写 / 朗读次数(各自独立计数)。 */
    limits: { transcribe: WindowLimiter; speak: WindowLimiter };
    /** 测试中缩短超时。 */
    timeouts?: Pick<VoiceClientOptions, 'transcribeTimeoutMs' | 'speechFirstByteTimeoutMs' | 'speechIdleTimeoutMs'>;
    now?: () => number;
}

/** 转写请求在录音之外的表单开销上限;整个请求体由 app.ts 的 bodyLimit 卡住。 */
export const TRANSCRIPTION_OVERHEAD_BYTES = 64 * 1024;

const TranscriptionForm = z.object({
    file: z
        .custom<File>((v) => v instanceof File, { message: 'file is required' })
        .openapi({ type: 'string', format: 'binary', description: 'WebM, Ogg, MP4/M4A, WAV or MP3, at most 10 MiB' }),
    language: z
        .string()
        .regex(/^[a-z]{2}$/, 'ISO 639-1 code such as zh or en')
        .optional()
        .openapi({ description: 'Defaults to the UI language in settings' }),
    profileId: Id.optional().openapi({ description: 'Overrides settings.voice.defaultSttProfileId' }),
});

const providerErrors = {
    404: problem('The given profile does not exist'),
    409: problem('No usable speech profile, or its key is not set'),
    429: problem('Too many voice requests this minute'),
    502: problem('The speech endpoint failed or timed out (see providerCode)'),
};

const transcriptionRoute = createRoute({
    method: 'post',
    path: '/voice/transcriptions',
    tags: ['voice'],
    summary: 'Transcribe a recording with the speech-to-text profile',
    request: { body: { content: { 'multipart/form-data': { schema: TranscriptionForm } }, required: true } },
    responses: {
        200: json(TranscriptionResult, 'The transcription; empty text when nothing was heard'),
        400: problem('Invalid request or the profile is not a speech-to-text profile'),
        413: problem('The recording is larger than 10 MiB'),
        415: problem('Not a supported audio format'),
        ...providerErrors,
        ...authErrors,
    },
});

const audio = z.string().openapi({ type: 'string', format: 'binary' });
const speechRoute = createRoute({
    method: 'post',
    path: '/voice/speech',
    tags: ['voice'],
    summary: 'Read text aloud with the text-to-speech profile (streamed audio)',
    request: { body: { content: { 'application/json': { schema: SpeechRequest } }, required: true } },
    responses: {
        200: {
            content: {
                'audio/mpeg': { schema: audio },
                'audio/ogg': { schema: audio },
                'audio/wav': { schema: audio },
            },
            description: 'The audio, streamed as it arrives from the endpoint',
        },
        400: problem('Invalid request or the profile is not a text-to-speech profile'),
        ...providerErrors,
        ...authErrors,
    },
});

type VoicePurpose = 'stt' | 'tts';

const usable = (p: ModelProfileRecord, purpose: VoicePurpose) =>
    p.kind === 'openai-compatible' && p.baseURL !== undefined && p.purpose.includes(purpose);

/** 按 ADR 0021 第 2 节选配置档:请求里给出的 → 设置里的默认 → 第一个可用的。 */
function pickProfile(
    deps: VoiceRouteDeps,
    ownerId: string,
    purpose: VoicePurpose,
    requested: string | undefined,
): ModelProfileRecord {
    const profiles = deps.repos.modelProfiles.list(ownerId);
    let profile: ModelProfileRecord | undefined;
    if (requested) {
        profile = profiles.find((p) => p.id === requested);
        if (!profile) throw notFound('Model profile');
        if (!usable(profile, purpose)) {
            throw new ApiError(400, 'validation_failed', 'Bad Request', 'The request is invalid.', {
                issues: [{ path: ['profileId'], message: `profile must be openai-compatible with purpose ${purpose}` }],
            });
        }
    } else {
        const voice = deps.repos.settings.get(ownerId).voice;
        const wanted = purpose === 'stt' ? voice.defaultSttProfileId : voice.defaultTtsProfileId;
        profile =
            profiles.find((p) => p.id === wanted && usable(p, purpose)) ?? profiles.find((p) => usable(p, purpose));
        if (!profile) {
            const what = purpose === 'stt' ? 'speech-to-text' : 'text-to-speech';
            throw new ApiError(409, 'model_profile_missing', 'Conflict', `Create a ${what} model profile first.`);
        }
    }
    if (deps.providerDeps.secrets.status(profile.apiKeyRef) === 'missing') {
        throw new ApiError(
            409,
            'model_key_missing',
            'Conflict',
            `The key referenced by ${profile.apiKeyRef ?? ''} is not set.`,
        );
    }
    return profile;
}

function limit(limiter: WindowLimiter, ownerId: string) {
    const wait = limiter.take(ownerId);
    if (wait > 0) {
        throw new ApiError(429, 'rate_limited', 'Too Many Requests', 'Too many voice requests; try again shortly.', {
            headers: { 'Retry-After': String(wait) },
        });
    }
}

function upstreamError(error: unknown): unknown {
    if (!(error instanceof ProviderError)) return error;
    return new ApiError(502, 'provider_error', 'Bad Gateway', error.message, { providerCode: error.code });
}

function clientFor(deps: VoiceRouteDeps, profile: ModelProfileRecord) {
    return createVoiceClient({
        profile,
        getApiKey: () => deps.providerDeps.secrets.resolve(profile.apiKeyRef),
        redactor: deps.providerDeps.redactor,
        fetch: deps.providerDeps.fetch,
        ...deps.timeouts,
    });
}

export function voiceRoutes(deps: VoiceRouteDeps) {
    const now = deps.now ?? Date.now;
    return router()
        .openapi(transcriptionRoute, async (c) => {
            const ownerId = requireOwner(c);
            limit(deps.limits.transcribe, ownerId);
            const form = c.req.valid('form');
            const tooLarge = () =>
                new ApiError(413, 'payload_too_large', 'Payload Too Large', 'Recordings must be at most 10 MiB.');
            if (form.file.size > MAX_TRANSCRIPTION_BYTES) throw tooLarge();
            const profile = pickProfile(deps, ownerId, 'stt', form.profileId);
            const bytes = new Uint8Array(await form.file.arrayBuffer());
            if (bytes.length > MAX_TRANSCRIPTION_BYTES) throw tooLarge();
            const mediaType = sniffAudioType(bytes);
            if (!mediaType) {
                throw new ApiError(
                    415,
                    'unsupported_media_type',
                    'Unsupported Media Type',
                    'Only WebM, Ogg, MP4/M4A, WAV and MP3 recordings are accepted.',
                );
            }
            const language = form.language ?? (deps.repos.settings.get(ownerId).locale === 'en' ? 'en' : 'zh');
            const started = now();
            const log = c.get('logger');
            try {
                const text = await clientFor(deps, profile).transcribe({
                    audio: bytes,
                    mediaType,
                    language,
                    signal: c.req.raw.signal,
                });
                log.info(
                    { profileId: profile.id, bytes: bytes.length, chars: text.length, durationMs: now() - started },
                    'voice transcription',
                );
                return c.json({ text, profileId: profile.id }, 200);
            } catch (error) {
                log.warn(
                    {
                        profileId: profile.id,
                        bytes: bytes.length,
                        durationMs: now() - started,
                        providerCode: error instanceof ProviderError ? error.code : undefined,
                    },
                    'voice transcription failed',
                );
                throw upstreamError(error);
            }
        })
        .openapi(speechRoute, async (c) => {
            const ownerId = requireOwner(c);
            limit(deps.limits.speak, ownerId);
            const body = c.req.valid('json');
            const profile = pickProfile(deps, ownerId, 'tts', body.profileId);
            const format = body.format ?? 'mp3';
            const started = now();
            const log = c.get('logger');
            const meta = { profileId: profile.id, chars: body.text.length };
            let stream: ReadableStream<Uint8Array>;
            try {
                stream = await clientFor(deps, profile).speak({ text: body.text, format, signal: c.req.raw.signal });
            } catch (error) {
                log.warn(
                    {
                        ...meta,
                        durationMs: now() - started,
                        providerCode: error instanceof ProviderError ? error.code : undefined,
                    },
                    'voice speech failed',
                );
                throw upstreamError(error);
            }
            log.info({ ...meta, firstByteMs: now() - started }, 'voice speech');
            return c.body(stream, 200, {
                'Content-Type': SPEECH_CONTENT_TYPES[format],
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            });
        });
}
