// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { PluginPrepared } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { describePrepared } from './plugins.js';

function prepared(patch: Partial<PluginPrepared['manifest']['permissions']> = {}, unreviewed = true): PluginPrepared {
    return {
        stagingId: '0123456789abcdef',
        unreviewed,
        market: null,
        installed: null,
        protections: [{ key: 'direct-network', level: 'layered', detail: 'preload only' }],
        manifest: {
            manifestVersion: 1,
            id: 'weather',
            version: '1.0.0',
            name: { en: 'Weather' },
            description: { en: 'City forecasts' },
            author: 'Example',
            license: 'MIT',
            engines: { fatcat: '>=1.1.0' },
            entry: { type: 'mcp-stdio', main: 'server.js' },
            permissions: { tools: [], net: [], secrets: [], ...patch },
        },
    };
}

describe('describePrepared', () => {
    it('lists every permission, the protection table and the unreviewed warning', () => {
        const text = describePrepared(
            prepared({
                tools: [{ name: 'forecast', risk: 'external', sendsData: true }],
                net: ['api.weather.example'],
                secrets: [{ name: 'WEATHER_KEY', required: true }],
            }),
        ).join('\n');
        expect(text).toContain('tool    forecast [external, sends your data out]');
        expect(text).toContain('network api.weather.example');
        expect(text).toContain('secret  WEATHER_KEY (required)');
        expect(text).toContain('direct-network     layered');
        expect(text).toContain('WARNING: local folder');
    });

    it('says so when there are no permissions and omits the warning for reviewed plugins', () => {
        const text = describePrepared(prepared({}, false)).join('\n');
        expect(text).toContain('(none)');
        expect(text).not.toContain('WARNING');
    });
});
