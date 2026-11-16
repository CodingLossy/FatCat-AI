// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// check-egress.mjs 的自测:在临时夹具目录里造一份迷你仓库,不扫真实仓库。
// 运行:node --test scripts/check-egress.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { checkEgress } from './check-egress.mjs';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** files: 相对路径 → 内容;registry: 登记表。 */
function fixture(files, registry) {
    const root = mkdtempSync(join(tmpdir(), 'egress-'));
    dirs.push(root);
    const all = { ...files, 'scripts/egress-registry.json': JSON.stringify(registry) };
    for (const [path, text] of Object.entries(all)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
    }
    return root;
}

const EGRESS = 'export function modelTargets() { return []; }\n';
const CALLER = "export const get = () => fetch('https://example.com');\n";
const entry = { file: 'packages/p/src/http.ts', kind: 'fixed', listedAs: 'modelTargets', reason: 'model calls' };

test('an unregistered network call site fails', () => {
    const root = fixture({ 'apps/server/src/egress.ts': EGRESS, 'packages/p/src/http.ts': CALLER }, []);
    const errors = checkEgress(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /http\.ts: uses a network API but is not in the egress registry/);
});

test('a registry entry without a network call in the code fails', () => {
    const root = fixture({ 'apps/server/src/egress.ts': EGRESS, 'packages/p/src/http.ts': 'export const x = 1;\n' }, [
        entry,
    ]);
    const errors = checkEgress(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /registered, but no network API is used/);
});

test('a fixed entry whose listedAs is not a symbol of egress.ts fails', () => {
    const root = fixture({ 'apps/server/src/egress.ts': EGRESS, 'packages/p/src/http.ts': CALLER }, [
        { ...entry, listedAs: 'missingTargets' },
    ]);
    const errors = checkEgress(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /listedAs "missingTargets" is not defined/);
});

test('everything registered passes; tests, comments and non-production dirs are not scanned', () => {
    const root = fixture(
        {
            'apps/server/src/egress.ts': EGRESS,
            'packages/p/src/http.ts': CALLER,
            'packages/p/src/http.test.ts': CALLER,
            'packages/p/src/note.ts': '// fetch( is only mentioned in a comment\nexport const y = 2;\n',
            'packages/p/e2e/run.ts': CALLER,
            'scripts/tool.mjs': CALLER,
        },
        [entry],
    );
    assert.deepEqual(checkEgress(root), []);
});

// 每种写法一个文件,空登记表下都必须被报出来(X 审查 #34 里漏检的几种,加上其余网络库)
const MISSED = {
    'default-https.ts': "import https from 'https';\nexport const a = https;\n",
    'named-http2.ts': "import { request } from 'node:http2';\nexport const a = request;\n",
    'fetch-default-arg.ts': 'export const a = (fetchImpl = fetch) => fetchImpl("https://example.com");\n',
    'fetch-assigned.ts': 'const f = fetch;\nexport const a = f;\n',
    'fetch-passed.ts': 'export const a = run(fetch, 1);\nexport const b = run(1, fetch);\n',
    'require-net.ts': "const net = require('net');\nexport const a = net;\n",
    'bare-tls.ts': "import tls from 'tls';\nexport const a = tls;\n",
    'dynamic-dgram.ts': "export const a = () => import('node:dgram');\n",
    'ws.ts': "import { WebSocket as Ws } from 'ws';\nexport const a = Ws;\n",
    'node-fetch.ts': "import nodeFetch from 'node-fetch';\nexport const a = nodeFetch;\n",
    'axios.ts': "import axios from 'axios';\nexport const a = axios;\n",
    'got.ts': "import got from 'got';\nexport const a = got;\n",
    'mcp-sse.ts':
        "import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';\nexport const a = SSEClientTransport;\n",
    'mcp-http.ts':
        "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';\nexport const a = StreamableHTTPClientTransport;\n",
};

for (const [name, text] of Object.entries(MISSED)) {
    test(`unregistered network use is reported: ${name}`, () => {
        const root = fixture({ 'apps/server/src/egress.ts': EGRESS, [`packages/p/src/${name}`]: text }, []);
        const errors = checkEgress(root);
        assert.equal(errors.length, 1, errors.join('\n'));
        assert.match(errors[0], new RegExp(`${name.replace('.', '\\.')}: uses a network API`));
    });
}

test('plain strings and stdio MCP use are not mistaken for network use', () => {
    const root = fixture(
        {
            'apps/server/src/egress.ts': EGRESS,
            'packages/p/src/plain.ts':
                "export const a = { security: 'tls', type: 'http', scheme: 'https' };\nexport const b = 'got it';\n" +
                "import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';\n",
        },
        [],
    );
    assert.deepEqual(checkEgress(root), []);
});
