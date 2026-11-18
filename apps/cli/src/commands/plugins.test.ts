// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { PluginPrepared } from '@fatcat-ai/shared';
import { describe, expect, it } from 'vitest';
import { describePrepared, describeUpgrade, marketRows } from './plugins.js';

function prepared(patch: Partial<PluginPrepared['manifest']['permissions']> = {}, unreviewed = true): PluginPrepared {
    return {
        stagingId: '0123456789abcdef',
        unreviewed,
        market: null,
        upgrade: null,
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

describe('describeUpgrade and marketRows', () => {
    it('lists new and removed permissions and warns when the data is too large to back up', () => {
        const base = prepared();
        const text = describeUpgrade({
            ...base,
            installed: { version: '0.9.0', state: 'enabled' },
            upgrade: {
                fromVersion: '0.9.0',
                dataBytes: 600 * 1048576,
                backupTooLarge: true,
                diff: {
                    added: [
                        { kind: 'tool-risk', name: 'forecast', from: 'read', to: 'write' },
                        { kind: 'net', name: 'api.example.com', from: null, to: null },
                    ],
                    removed: [{ kind: 'secret', name: 'OLD_KEY', from: null, to: null }],
                },
            },
        }).join('\n');
        expect(text).toContain('v0.9.0 -> v1.0.0');
        expect(text).toContain('+ tool forecast: level read -> write');
        expect(text).toContain('+ network api.example.com');
        expect(text).toContain('- secret OLD_KEY');
        expect(text).toContain('will NOT be backed up');
        expect(describeUpgrade(base)).toEqual([]);
    });

    it('picks the newest compatible version for each market plugin', () => {
        const view = (version: string, compatible: boolean) => ({
            version,
            engines: '>=1.1.0',
            size: 1,
            publishedAt: '2026-11-18T00:00:00Z',
            permissions: { tools: [], net: [], secrets: [] },
            compatible,
        });
        const rows = marketRows({
            markets: [],
            plugins: [
                {
                    market: 'official',
                    id: 'weather',
                    name: { en: 'Weather' },
                    description: { en: 'x' },
                    author: 'Ex',
                    license: 'MIT',
                    homepage: null,
                    versions: [view('2.0.0', false), view('1.2.0', true), view('1.10.0', true)],
                    installed: { version: '1.0.0', state: 'enabled' },
                },
            ],
        });
        expect(rows).toEqual([['official', 'weather', '1.10.0', 'v1.0.0', 'Ex']]);
    });
});
