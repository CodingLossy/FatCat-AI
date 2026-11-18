// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    HeartbeatParams,
    ItemsUpsertParams,
    NetFetchParams,
    PluginIndex,
    compareSemver,
    diffPermissions,
    isSpdxExpression,
    parsePluginManifest,
    parseSemver,
    satisfiesEngine,
    validatePluginSettings,
    type PluginPermissions,
    type PluginSettings,
} from './plugin.js';

function manifest(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        manifestVersion: 1,
        id: 'weather',
        version: '1.2.0',
        name: { 'zh-CN': '天气', en: 'Weather' },
        description: { en: 'City weather forecasts' },
        author: 'Example Author',
        license: 'MIT',
        homepage: 'https://example.org/weather-plugin',
        engines: { fatcat: '>=1.1.0 <2.0.0' },
        entry: { type: 'mcp-stdio', main: 'dist/server.js' },
        permissions: {
            tools: [{ name: 'forecast', risk: 'read' }],
            net: ['api.open-meteo.com', '*.example.org'],
            secrets: [{ name: 'WEATHER_API_KEY', required: false }],
            items: { categories: [{ type: 'video', title: { en: 'Videos' } }] },
        },
        settings: {
            type: 'object',
            properties: { unit: { type: 'string', enum: ['c', 'f'], default: 'c' } },
        },
        taskTemplates: [
            {
                title: { en: 'Morning weather' },
                prompt: 'Check today',
                trigger: { kind: 'cron', expression: '0 7 * * *' },
            },
        ],
        licensing: { model: 'free' },
        ...patch,
    };
}

function check(value: unknown): { ok: boolean; paths: string[] } {
    const result = parsePluginManifest(JSON.stringify(value));
    return { ok: result.ok, paths: result.ok ? [] : result.issues.map((i) => i.path) };
}

describe('plugin.json', () => {
    it('accepts the ADR example and ignores x- fields', () => {
        expect(check(manifest()).ok).toBe(true);
        expect(check(manifest({ 'x-note': 1, permissions: { 'x-y': true, tools: [] } })).ok).toBe(true);
    });

    it.each([
        ['an unknown field', { extra: 1 }],
        ['an unknown nested field', { entry: { type: 'mcp-stdio', main: 'a.js', args: [] } }],
        ['a dangerous tool', { permissions: { tools: [{ name: 'rm', risk: 'dangerous' }] } }],
        ['a broad domain', { permissions: { net: ['*.com'] } }],
        ['a domain with a path', { permissions: { net: ['example.com/x'] } }],
        ['an upper-case domain', { permissions: { net: ['Example.com'] } }],
        ['a FATCAT_AI_ secret', { permissions: { secrets: [{ name: 'FATCAT_AI_TOKEN' }] } }],
        ['an AIP_ secret', { permissions: { secrets: [{ name: 'AIP_TOKEN' }] } }],
        ['a paid licensing model', { licensing: { model: 'paid' } }],
        [
            'too many tools',
            { permissions: { tools: Array.from({ length: 51 }, (_, i) => ({ name: `t${i}`, risk: 'read' })) } },
        ],
        [
            'a duplicate tool',
            {
                permissions: {
                    tools: [
                        { name: 'a', risk: 'read' },
                        { name: 'a', risk: 'write' },
                    ],
                },
            },
        ],
        ['an entry outside the package', { entry: { type: 'mcp-stdio', main: '../x.js' } }],
        ['an absolute entry', { entry: { type: 'mcp-stdio', main: '/x.js' } }],
        ['a non-js entry', { entry: { type: 'mcp-stdio', main: 'server.py' } }],
        ['a bad id', { id: 'Weather' }],
        ['a +build version', { version: '1.0.0+abc' }],
        ['an http homepage', { homepage: 'http://example.org' }],
        ['an unsupported engines range', { engines: { fatcat: '^1.1.0' } }],
        ['an empty name', { name: {} }],
        ['an unknown language', { name: { fr: 'Météo' } }],
        ['a bad license', { license: 'MIT AND' }],
        ['a setting of another type', { settings: { type: 'object', properties: { x: { type: 'array' } } } }],
        [
            'an enum default outside the enum',
            { settings: { type: 'object', properties: { u: { type: 'string', enum: ['a'], default: 'b' } } } },
        ],
        [
            'a template with a once trigger',
            {
                taskTemplates: [
                    { title: { en: 'x' }, prompt: 'p', trigger: { kind: 'once', at: '2030-01-01T00:00:00Z' } },
                ],
            },
        ],
        [
            'a template with preauthorized tools',
            {
                taskTemplates: [
                    { title: { en: 'x' }, prompt: 'p', trigger: { kind: 'cron', expression: '* * * * *' }, policy: {} },
                ],
            },
        ],
    ])('rejects %s', (_name, patch) => {
        expect(check(manifest(patch)).ok).toBe(false);
    });

    it('rejects a missing required field and reports the path', () => {
        const value = manifest();
        delete value.entry;
        expect(check(value)).toEqual({ ok: false, paths: ['entry'] });
    });

    it('enforces the 64 KiB limit and reports invalid JSON', () => {
        const big = JSON.stringify(manifest({ 'x-pad': 'a'.repeat(70 * 1024) }));
        expect(parsePluginManifest(big)).toMatchObject({ ok: false, error: 'too_large' });
        expect(parsePluginManifest('{oops')).toMatchObject({ ok: false, error: 'invalid_json' });
    });
});

describe('engines', () => {
    it('parses and compares semver', () => {
        expect(parseSemver('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3, pre: ['beta', '1'] });
        expect(parseSemver('01.2.3')).toBeNull();
        expect(parseSemver('1.2.3+b')).toBeNull();
        const order = [
            '1.0.0-alpha',
            '1.0.0-alpha.1',
            '1.0.0-alpha.beta',
            '1.0.0-beta.2',
            '1.0.0-beta.11',
            '1.0.0',
            '1.0.1',
        ];
        for (let i = 1; i < order.length; i++) {
            expect(compareSemver(parseSemver(order[i - 1]!)!, parseSemver(order[i]!)!)).toBe(-1);
        }
    });

    it('matches both supported range forms', () => {
        expect(satisfiesEngine('1.1.0', '>=1.1.0')).toBe(true);
        expect(satisfiesEngine('1.0.9', '>=1.1.0')).toBe(false);
        expect(satisfiesEngine('99.0.0', '>=1.1.0')).toBe(true);
        expect(satisfiesEngine('1.9.9', '>=1.1.0 <2.0.0')).toBe(true);
        expect(satisfiesEngine('2.0.0', '>=1.1.0 <2.0.0')).toBe(false);
        expect(satisfiesEngine('1.1.0-rc.1', '>=1.1.0')).toBe(false);
        expect(satisfiesEngine('1.1.0', '>=1.1.0 <1.0.0')).toBe(false);
        expect(satisfiesEngine('1.1.0', '~1.1.0')).toBe(false);
    });
});

describe('SPDX expressions', () => {
    it('checks the shape', () => {
        for (const ok of [
            'MIT',
            'Apache-2.0',
            'MIT OR Apache-2.0',
            '(MIT OR GPL-2.0+) AND BSD-3-Clause',
            'GPL-2.0 WITH Classpath-exception-2.0',
        ]) {
            expect(isSpdxExpression(ok)).toBe(true);
        }
        for (const bad of ['', 'MIT AND', 'OR MIT', '(MIT', 'MIT)', 'MIT Apache', '$MIT']) {
            expect(isSpdxExpression(bad)).toBe(false);
        }
    });
});

describe('market index', () => {
    const sha = 'a'.repeat(64);
    function index(patch: Record<string, unknown> = {}, version: Record<string, unknown> = {}): unknown {
        return {
            formatVersion: 1,
            market: 'official',
            serial: 42,
            generatedAt: '2026-12-01T08:00:00Z',
            expiresAt: '2027-01-01T08:00:00Z',
            downloadHosts: ['github.com'],
            plugins: [
                {
                    id: 'weather',
                    name: { en: 'Weather' },
                    description: { en: 'Forecasts' },
                    author: 'A',
                    license: 'MIT',
                    versions: [
                        {
                            version: '1.2.0',
                            engines: { fatcat: '>=1.1.0' },
                            url: 'https://github.com/x/y/releases/download/v1.2.0/w.tgz',
                            size: 1000,
                            sha256: sha,
                            permissions: { tools: [{ name: 'forecast', risk: 'read' }] },
                            publishedAt: '2026-11-30T12:00:00Z',
                            ...version,
                        },
                    ],
                    licensing: { model: 'free' },
                },
            ],
            ...patch,
        };
    }

    it('accepts a valid index', () => {
        expect(PluginIndex.safeParse(index()).success).toBe(true);
    });

    it.each([
        ['a download host that is not listed', index({}, { url: 'https://evil.example/w.tgz' })],
        ['an http url', index({ downloadHosts: ['github.com'] }, { url: 'http://github.com/w.tgz' })],
        ['a bad sha256', index({}, { sha256: 'xyz' })],
        ['an oversize package', index({}, { size: 60 * 1024 * 1024 })],
        ['a yanked version without a reason', index({}, { yanked: true })],
        [
            'a duplicate plugin id',
            (() => {
                const i = index() as { plugins: unknown[] };
                i.plugins.push(i.plugins[0]);
                return i;
            })(),
        ],
        ['an unknown field', index({ extra: 1 })],
    ])('rejects %s', (_name, value) => {
        expect(PluginIndex.safeParse(value).success).toBe(false);
    });
});

describe('fatcat/* messages', () => {
    it('restricts net.fetch', () => {
        expect(NetFetchParams.safeParse({ url: 'https://api.example.org/x' }).success).toBe(true);
        expect(NetFetchParams.safeParse({ url: 'http://api.example.org/x' }).success).toBe(false);
        expect(NetFetchParams.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
        expect(NetFetchParams.safeParse({ url: 'https://a.org', headers: { Cookie: 'a=b' } }).success).toBe(false);
        expect(
            NetFetchParams.safeParse({ url: 'https://a.org', headers: { 'proxy-authorization': 'x' } }).success,
        ).toBe(false);
        expect(NetFetchParams.safeParse({ url: 'https://a.org', body: 'x' }).success).toBe(false);
        expect(NetFetchParams.safeParse({ url: 'https://a.org', method: 'POST', body: 'x' }).success).toBe(true);
    });

    it('limits items.upsert batches and meta size', () => {
        const item = { id: '1', type: 'video', title: 'T' };
        expect(ItemsUpsertParams.safeParse({ items: [item] }).success).toBe(true);
        expect(ItemsUpsertParams.safeParse({ items: Array.from({ length: 501 }, () => item) }).success).toBe(false);
        expect(ItemsUpsertParams.safeParse({ items: [{ ...item, meta: { blob: 'x'.repeat(9000) } }] }).success).toBe(
            false,
        );
    });

    it('validates the heartbeat', () => {
        expect(HeartbeatParams.safeParse({ rss: 1024 }).success).toBe(true);
        expect(HeartbeatParams.safeParse({ rss: -1 }).success).toBe(false);
    });
});

describe('validatePluginSettings', () => {
    const schema: PluginSettings = {
        type: 'object',
        properties: {
            city: { type: 'string', maxLength: 5 },
            unit: { type: 'string', enum: ['c', 'f'] },
            days: { type: 'number', minimum: 1, maximum: 7 },
            alerts: { type: 'boolean' },
        },
        required: ['city'],
    };

    it('accepts declared values of the right type', () => {
        expect(validatePluginSettings(schema, { city: 'Paris', unit: 'c', days: 3, alerts: false })).toEqual([]);
    });

    it('rejects undeclared keys, wrong types, out-of-range values and a missing required one', () => {
        expect(validatePluginSettings(schema, { city: 'Paris', extra: 1 })).toEqual([
            'extra: not declared by the plugin',
        ]);
        expect(validatePluginSettings(schema, { city: 'Paris', unit: 'k', days: 9, alerts: 'yes' })).toEqual([
            'unit: not one of the allowed values',
            'days: at most 7',
            'alerts: must be true or false',
        ]);
        expect(validatePluginSettings(schema, { city: 'Beijing' })).toEqual(['city: at most 5 characters']);
        expect(validatePluginSettings(schema, {})).toEqual(['city: required']);
    });

    it('does not treat names on the prototype chain as declared keys', () => {
        const values = JSON.parse('{"city":"Paris","constructor":true,"toString":false,"__proto__":1}') as Record<
            string,
            unknown
        >;
        expect(validatePluginSettings(schema, values)).toEqual([
            'constructor: not declared by the plugin',
            'toString: not declared by the plugin',
            '__proto__: not declared by the plugin',
        ]);
    });

    it('rejects every value when the plugin declares no settings', () => {
        expect(validatePluginSettings(undefined, {})).toEqual([]);
        expect(validatePluginSettings(undefined, { a: 1 })).toEqual(['a: not declared by the plugin']);
    });
});

describe('diffPermissions', () => {
    const base: PluginPermissions = {
        tools: [
            { name: 'forecast', risk: 'read' },
            { name: 'save', risk: 'write' },
        ],
        net: ['api.example.org'],
        secrets: [{ name: 'API_KEY', required: true }],
    };

    it('is empty when nothing changed and when permissions only shrink the surface', () => {
        expect(diffPermissions(base, base)).toEqual({ added: [], removed: [] });
        const smaller: PluginPermissions = { tools: [{ name: 'forecast', risk: 'read' }], net: [], secrets: [] };
        const diff = diffPermissions(base, smaller);
        expect(diff.added).toEqual([]);
        expect(diff.removed.map((c) => `${c.kind}:${c.name}`).sort()).toEqual([
            'net:api.example.org',
            'secret:API_KEY',
            'tool:save',
        ]);
    });

    it('flags new tools, raised risk, new sendsData, new domains, secrets and categories as additions', () => {
        const next: PluginPermissions = {
            tools: [
                { name: 'forecast', risk: 'write', sendsData: true },
                { name: 'save', risk: 'write' },
                { name: 'delete', risk: 'external' },
            ],
            net: ['api.example.org', 'cdn.example.org'],
            secrets: [
                { name: 'API_KEY', required: true },
                { name: 'EXTRA', required: false },
            ],
            items: { categories: [{ type: 'note', title: { en: 'Notes' } }] },
        };
        const diff = diffPermissions(base, next);
        expect(diff.removed).toEqual([]);
        expect(diff.added.map((c) => `${c.kind}:${c.name}:${c.from ?? ''}>${c.to ?? ''}`).sort()).toEqual([
            'category:note:>',
            'net:cdn.example.org:>',
            'secret:EXTRA:>',
            'tool-risk:forecast:read>write',
            'tool-sends-data:forecast:>',
            'tool:delete:>external',
        ]);
    });

    it('reports a lowered risk as a removal, never as something to consent to', () => {
        const lowered: PluginPermissions = {
            ...base,
            tools: [
                { name: 'forecast', risk: 'read' },
                { name: 'save', risk: 'read' },
            ],
        };
        const diff = diffPermissions(base, lowered);
        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([{ kind: 'tool-risk', name: 'save', from: 'write', to: 'read' }]);
    });
});
