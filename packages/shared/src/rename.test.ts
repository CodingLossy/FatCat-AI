// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { applyLegacyEnv, isOwnEnvName, legacyEnvWarning } from './rename.js';

describe('applyLegacyEnv', () => {
    it('把旧名 AIP_* 补到新名上,并返回用到的旧名', () => {
        const env: Record<string, string | undefined> = { AIP_PORT: '9000', AIP_HOST: '0.0.0.0', OTHER: 'x' };
        expect(applyLegacyEnv(env, ['HOST', 'PORT', 'DATA_DIR'])).toEqual(['AIP_HOST', 'AIP_PORT']);
        expect(env).toMatchObject({ FATCAT_AI_PORT: '9000', FATCAT_AI_HOST: '0.0.0.0' });
        expect(env.FATCAT_AI_DATA_DIR).toBeUndefined();
    });

    it('新名已设置时以新名为准,但仍提示旧名', () => {
        const env: Record<string, string | undefined> = { AIP_PORT: '9000', FATCAT_AI_PORT: '8787' };
        expect(applyLegacyEnv(env, ['PORT'])).toEqual(['AIP_PORT']);
        expect(env.FATCAT_AI_PORT).toBe('8787');
    });

    it('提示里列出旧名与新名', () => {
        expect(legacyEnvWarning(['AIP_PORT'])).toContain('AIP_PORT → FATCAT_AI_PORT');
    });
});

describe('isOwnEnvName', () => {
    it('新旧前缀都算,大小写不敏感', () => {
        expect(isOwnEnvName('FATCAT_AI_TOKEN')).toBe(true);
        expect(isOwnEnvName('aip_token')).toBe(true);
        expect(isOwnEnvName('PATH')).toBe(false);
    });
});
