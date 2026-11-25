// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// check-owner-scope.mjs 的自测:只用内存里的源码文本,不扫真实仓库。
// 运行:node --test scripts/check-owner-scope.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkOwnerScope, scanRepositorySource } from './check-owner-scope.mjs';

const SOURCE = [
    'export function createThingRepository(conn) {',
    '    const q = {};',
    '    return {',
    '        list(ownerId: string): Thing[] {',
    '            return q.list.all(ownerId);',
    '        },',
    '        byId(id: string): Thing | null {',
    '            helper(id);',
    '            return q.get.get(id);',
    '        },',
    '        update(',
    '            ownerId: string,',
    '            id: string,',
    '        ): void {',
    '            q.update.run(ownerId, id);',
    '        },',
    '    };',
    '}',
    'export function createOtherRepository(conn) {',
    '    const owners = {',
    '        count(): number {',
    '            return 1;',
    '        },',
    '    };',
    '}',
].join('\n');

test('scans definitions (including multi-line signatures), skips call statements', () => {
    assert.deepEqual(scanRepositorySource('thing.ts', SOURCE), [
        { key: 'thing.ts:createThingRepository.list', owner: true },
        { key: 'thing.ts:createThingRepository.byId', owner: false },
        { key: 'thing.ts:createThingRepository.update', owner: true },
        { key: 'thing.ts:owners.count', owner: false },
    ]);
});

test('an unlisted method without ownerId fails; a listed one passes', () => {
    const found = scanRepositorySource('thing.ts', SOURCE);
    const errors = checkOwnerScope(found, [
        { key: 'thing.ts:owners.count', category: 'system', reason: 'Setup checks whether an owner exists.' },
    ]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /createThingRepository\.byId: no ownerId parameter/);
});

test('stale, duplicated, badly categorized or unexplained entries fail', () => {
    const found = scanRepositorySource('thing.ts', SOURCE);
    const ok = { category: 'child', reason: 'Caller loaded the parent with ownerId.' };
    const errors = checkOwnerScope(found, [
        { key: 'thing.ts:createThingRepository.byId', ...ok },
        { key: 'thing.ts:createThingRepository.byId', ...ok },
        { key: 'thing.ts:owners.count', category: 'whatever', reason: 'Setup checks the owner count.' },
        { key: 'thing.ts:createThingRepository.list', ...ok },
        { key: 'thing.ts:gone.method', category: 'system', reason: 'short' },
    ]);
    assert.ok(errors.some((e) => /byId: listed twice/.test(e)));
    assert.ok(errors.some((e) => /count: unknown category/.test(e)));
    assert.ok(errors.some((e) => /list: takes ownerId now/.test(e)));
    assert.ok(errors.some((e) => /gone\.method: give a reason/.test(e)));
    assert.ok(errors.some((e) => /gone\.method: listed but not found/.test(e)));
});
