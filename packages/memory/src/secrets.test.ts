// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { CREDENTIAL_NEGATIVES, CREDENTIAL_POSITIVES } from './fixtures/credential-corpus.js';
import { detectCredential, detectCredentialIn, redactCredentials } from './secrets.js';
import { chineseIdValid, luhnValid, redactSensitive, redactSensitiveIn } from './sensitive.js';

describe('凭据检测语料评测', () => {
    it('语料规模:正例 ≥ 60、反例 ≥ 60', () => {
        expect(CREDENTIAL_POSITIVES.length).toBeGreaterThanOrEqual(60);
        expect(CREDENTIAL_NEGATIVES.length).toBeGreaterThanOrEqual(60);
    });

    it('正例召回 100%', () => {
        const missed = CREDENTIAL_POSITIVES.filter((t) => detectCredential(t) === null);
        expect(missed).toEqual([]);
    });

    it('反例误报 ≤ 5%', () => {
        const flagged = CREDENTIAL_NEGATIVES.filter((t) => detectCredential(t) !== null);
        expect(flagged.length / CREDENTIAL_NEGATIVES.length).toBeLessThanOrEqual(0.05);
    });

    it('redactCredentials:正例都能定位并替换,替换后不再检出;反例原样保留(知识库入库前用)', () => {
        for (const text of CREDENTIAL_POSITIVES) {
            const r = redactCredentials(text);
            expect(r.count, text).toBeGreaterThan(0);
            expect(detectCredential(r.text), r.text).toBeNull();
        }
        const changed = CREDENTIAL_NEGATIVES.filter((t) => redactCredentials(t).text !== t);
        expect(changed.length / CREDENTIAL_NEGATIVES.length).toBeLessThanOrEqual(0.05);
    });

    it('JSON 值中的凭据也能检测到', () => {
        expect(detectCredentialIn({ note: CREDENTIAL_POSITIVES[0] })).toBe('api_key');
        expect(detectCredentialIn({ city: '杭州' })).toBeNull();
        expect(detectCredentialIn(null)).toBeNull();
    });
});

describe('写入时脱敏', () => {
    // 6222 0212 3456 7894 只是满足 Luhn 的测试号码
    it('Luhn 与身份证校验位', () => {
        expect(luhnValid('6222021234567894')).toBe(true);
        expect(luhnValid('6222021234567895')).toBe(false);
        expect(chineseIdValid('11010519491231002X')).toBe(true);
        expect(chineseIdValid('110105194912310021')).toBe(false);
    });

    it.each([
        ['我的工资卡是 6222 0212 3456 7894', '我的工资卡是 [银行卡 ****7894]', 'bank_card'],
        ['身份证号 11010519491231002X', '身份证号 [身份证 已隐藏]', 'id_card'],
        ['手机 138-1234-5678', '手机 [手机号 ****5678]', 'phone'],
        ['电话 +86 13912345678', '电话 [手机号 ****5678]', 'phone'],
        ['我住在杭州市西湖区文三路 100 号', '我住在杭州市[详细住址]', 'address'],
        ['我住在西湖区文三路100号5栋302室', '我住在[详细住址]', 'address'],
        ['住阳光花园3栋2单元501室', '[详细住址]', 'address'],
        ['I live at 221 Baker Street, Apt 2', 'I live at [详细住址]', 'address'],
    ])('%s', (input, expected, kind) => {
        const r = redactSensitive(input);
        expect(r.text).toBe(expected);
        expect(r.sensitivity).toBe(2);
        expect(r.kinds).toContain(kind);
    });

    it('不通过校验的数字串不脱敏', () => {
        expect(redactSensitive('订单号 6222021234567895').text).toBe('订单号 6222021234567895');
        expect(redactSensitive('订单号 6222021234567895').sensitivity).toBe(0);
    });

    it('生日、家庭成员为 sensitivity 1,只标记不替换', () => {
        expect(redactSensitive('我妈妈的生日是 5 月 3 日')).toEqual({
            text: '我妈妈的生日是 5 月 3 日',
            sensitivity: 1,
            kinds: ['personal'],
        });
        expect(redactSensitive('用户喜欢简洁的回答').sensitivity).toBe(0);
    });

    it('递归脱敏结构化值', () => {
        expect(redactSensitiveIn({ phone: '13812345678', city: '杭州' })).toEqual({
            value: { phone: '[手机号 ****5678]', city: '杭州' },
            sensitivity: 2,
        });
    });
});
