// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 语音的契约(ADR 0021)。Settings.voice 与 params.voice 自 M4 PR 4 起提供;
// ClientFrame 的 voice-state 与 ToolInfo.activityLabel 在 PR 5 接入。
import { z } from 'zod';
import { Id } from './common.js';
import { isRiff, matchesAt } from './magic.js';

export const AUDIO_MEDIA_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg'] as const;
export const AudioMediaType = z.enum(AUDIO_MEDIA_TYPES);
export type AudioMediaType = z.infer<typeof AudioMediaType>;

/** 转写请求中录音的上限(10 MiB)。 */
export const MAX_TRANSCRIPTION_BYTES = 10 * 1024 * 1024;
/** 录音时长上限;M4 由客户端在录音时卡住,服务器只检查字节数(ADR 0021 第 3 节)。 */
export const MAX_RECORDING_SECONDS = 120;
/** 每次朗读请求的字符上限;更长的回复由客户端按句子切段。 */
export const MAX_SPEECH_CHARS = 4000;

/** POST /api/v1/voice/transcriptions 的响应(M4 PR 4 起提供)。 */
export const TranscriptionResult = z.object({
    /** 去掉首尾空白;没听清时为空字符串。 */
    text: z.string(),
    /** 实际使用的 STT 配置档。 */
    profileId: Id,
});
export type TranscriptionResult = z.infer<typeof TranscriptionResult>;

export const SpeechFormat = z.enum(['mp3', 'opus', 'wav']);
export type SpeechFormat = z.infer<typeof SpeechFormat>;

export const SPEECH_CONTENT_TYPES: Record<SpeechFormat, string> = {
    mp3: 'audio/mpeg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
};

/** POST /api/v1/voice/speech 的请求体(M4 PR 4 起提供);响应为音频流。 */
export const SpeechRequest = z.strictObject({
    text: z.string().trim().min(1).max(MAX_SPEECH_CHARS),
    profileId: Id.optional(),
    /** 默认 mp3。 */
    format: SpeechFormat.optional(),
});
export type SpeechRequest = z.infer<typeof SpeechRequest>;

/** Settings.voice(M4 PR 4 起提供)。 */
export const VoiceSettings = z.object({
    /** 为 null 时取第一个 purpose 含 stt 的配置档。 */
    defaultSttProfileId: Id.nullable(),
    defaultTtsProfileId: Id.nullable(),
    /** 按住说话松开后自动发送;false 时只填进输入框。 */
    autoSend: z.boolean(),
    /** 回复结束后自动朗读。 */
    autoSpeak: z.boolean(),
});
export type VoiceSettings = z.infer<typeof VoiceSettings>;

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
    defaultSttProfileId: null,
    defaultTtsProfileId: null,
    autoSend: true,
    autoSpeak: false,
};

/** WebSocket 客户端帧 voice-state 的 payload(PR 5 起提供);不带电平(ADR 0021 第 6 节)。 */
export const VoiceStateReport = z.object({
    state: z.enum(['listening', 'speaking', 'idle']),
    sessionId: Id.nullable(),
});
export type VoiceStateReport = z.infer<typeof VoiceStateReport>;

/**
 * ISO-BMFF 的 major brand 白名单:浏览器录音(Safari)与常见音频。`ftyp` 本身也出现在 HEIC 图片与 MP4 视频中,
 * 只看 `ftyp` 会把它们当成录音(ADR 0021 第 3 节)。
 */
const MP4_AUDIO_BRANDS = new Set([
    'M4A ',
    'M4B ',
    'mp41',
    'mp42',
    'isom',
    'iso2',
    'iso5',
    'iso6',
    'dash',
    '3gp4',
    '3gp5',
]);

const brandOf = (bytes: Uint8Array) => String.fromCharCode(...bytes.subarray(8, 12));

/** 按魔数判断录音类型;不信任文件名与 Content-Type(ADR 0021 第 3 节)。 */
export function sniffAudioType(bytes: Uint8Array): AudioMediaType | null {
    if (matchesAt(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'audio/webm';
    if (matchesAt(bytes, [0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg';
    if (matchesAt(bytes, [0x66, 0x74, 0x79, 0x70], 4) && MP4_AUDIO_BRANDS.has(brandOf(bytes))) return 'audio/mp4';
    if (isRiff(bytes, 'WAVE')) return 'audio/wav';
    if (matchesAt(bytes, [0x49, 0x44, 0x33])) return 'audio/mpeg';
    // MPEG 帧同步:11 个 1,且版本与层不是保留值。
    const b1 = bytes[1];
    if (bytes[0] === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0 && (b1 & 0x18) !== 0x08 && (b1 & 0x06) !== 0) {
        return 'audio/mpeg';
    }
    return null;
}
