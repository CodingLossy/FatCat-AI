// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_SETTINGS, SpeechRequest, VoiceSettings, VoiceStateReport, sniffAudioType } from './voice.js';

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe('sniffAudioType', () => {
    it('按魔数识别浏览器与 IM 渠道常见的录音格式', () => {
        expect(sniffAudioType(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f))).toBe('audio/webm');
        expect(sniffAudioType(bytes(...ascii('OggS'), 0))).toBe('audio/ogg');
        expect(sniffAudioType(bytes(0, 0, 0, 0x20, ...ascii('ftypM4A ')))).toBe('audio/mp4');
        expect(sniffAudioType(bytes(0, 0, 0, 0x20, ...ascii('ftypiso5')))).toBe('audio/mp4');
        expect(sniffAudioType(bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WAVEfmt ')))).toBe('audio/wav');
        expect(sniffAudioType(bytes(...ascii('ID3'), 4, 0))).toBe('audio/mpeg');
        expect(sniffAudioType(bytes(0xff, 0xfb, 0x90, 0x00))).toBe('audio/mpeg');
    });

    it('图片、保留的 MPEG 头与截断的头都不算录音', () => {
        expect(sniffAudioType(bytes())).toBeNull();
        expect(sniffAudioType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBeNull(); // JPEG
        expect(sniffAudioType(bytes(0xff, 0xe9))).toBeNull(); // 保留版本
        expect(sniffAudioType(bytes(0xff, 0xf0))).toBeNull(); // 保留层
        expect(sniffAudioType(bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBP')))).toBeNull();
        expect(sniffAudioType(bytes(0, 0, 0, 0x20, ...ascii('fty')))).toBeNull();
        expect(sniffAudioType(bytes(0, 0, 0, 0x18, ...ascii('ftypheic')))).toBeNull(); // HEIC 图片
        expect(sniffAudioType(bytes(0, 0, 0, 0x18, ...ascii('ftypqt  ')))).toBeNull(); // QuickTime 视频
    });
});

describe('schema', () => {
    it('朗读文本 1–4,000 字,不接受未知字段', () => {
        expect(SpeechRequest.safeParse({ text: '你好' }).success).toBe(true);
        expect(SpeechRequest.safeParse({ text: '   ' }).success).toBe(false);
        expect(SpeechRequest.safeParse({ text: 'a'.repeat(4001) }).success).toBe(false);
        expect(SpeechRequest.safeParse({ text: 'hi', apiKey: 'sk-x' }).success).toBe(false);
        expect(SpeechRequest.safeParse({ text: 'hi', format: 'flac' }).success).toBe(false);
    });

    it('默认语音设置:自动发送开、自动朗读关', () => {
        expect(VoiceSettings.parse(DEFAULT_VOICE_SETTINGS)).toEqual({
            defaultSttProfileId: null,
            defaultTtsProfileId: null,
            autoSend: true,
            autoSpeak: false,
        });
    });

    it('状态上报只有三种状态,不带电平', () => {
        expect(VoiceStateReport.safeParse({ state: 'listening', sessionId: null }).success).toBe(true);
        expect(VoiceStateReport.safeParse({ state: 'thinking', sessionId: null }).success).toBe(false);
        expect(VoiceStateReport.parse({ state: 'speaking', sessionId: null, level: 0.5 })).not.toHaveProperty('level');
    });
});
