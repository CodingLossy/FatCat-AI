// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    Channel,
    ChannelCreate,
    ChannelKind,
    ChannelPairing,
    ChannelPatch,
    isSupportedTimeZone,
    TimeZoneName,
} from './index.js';

const ID = '01JC0000000000000000000000';
const NOW = '2026-11-11T08:00:00.000Z';

describe('channels (ADR 0022)', () => {
    it('1.0 只有 wechat;企业微信推迟,未知 kind 被拒绝', () => {
        expect(ChannelKind.options).toEqual(['wechat']);
        expect(ChannelCreate.safeParse({ kind: 'wecom', label: '企业微信' }).success).toBe(false);
        expect(ChannelCreate.parse({ kind: 'wechat', label: '  微信 ' })).toEqual({ kind: 'wechat', label: '微信' });
    });

    it('Channel 不带密钥字段;多余字段被剥掉', () => {
        const parsed = Channel.parse({
            id: ID,
            kind: 'wechat',
            label: '微信',
            enabled: false,
            sessionId: null,
            binding: { maskedExternalUserId: '****a1b2', boundAt: NOW },
            notifyDegraded: false,
            createdAt: NOW,
            updatedAt: NOW,
            tokenRef: 'file:ILINK_TOKEN',
        });
        expect(parsed).not.toHaveProperty('tokenRef');
    });

    it('ChannelPatch 只接受已知字段且至少一个', () => {
        expect(ChannelPatch.safeParse({}).success).toBe(false);
        expect(ChannelPatch.safeParse({ kind: 'wechat' }).success).toBe(false);
        expect(ChannelPatch.safeParse({ enabled: true }).success).toBe(true);
    });

    it('配对码是 6 位数字', () => {
        expect(ChannelPairing.safeParse({ code: '012345', expiresAt: NOW }).success).toBe(true);
        expect(ChannelPairing.safeParse({ code: '12345', expiresAt: NOW }).success).toBe(false);
        expect(ChannelPairing.safeParse({ code: '12345a', expiresAt: NOW }).success).toBe(false);
    });
});

describe('time zones (ADR 0023)', () => {
    it('接受 IANA 区域名与 UTC', () => {
        for (const tz of [
            'Asia/Shanghai',
            'America/Los_Angeles',
            'UTC',
            'Etc/GMT+8',
            'America/Argentina/Buenos_Aires',
        ]) {
            expect(isSupportedTimeZone(tz), tz).toBe(true);
        }
    });

    it('拒绝固定偏移、缩写与不存在的名字', () => {
        for (const tz of ['+08:00', 'CST', 'GMT', 'Mars/Olympus', '', 'Asia/Shanghai; rm -rf']) {
            expect(TimeZoneName.safeParse(tz).success, tz).toBe(false);
        }
    });
});
