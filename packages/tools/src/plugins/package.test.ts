// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPluginDir, PluginPackageError, prepareLocalPackage } from './package.js';

const example = fileURLToPath(new URL('../../../../examples/plugins/hello', import.meta.url));

describe('plugin packages', () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'fatcat-pkg-'));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

    it('stages and hashes a valid package, and the hash is stable', () => {
        const staging = join(root, 'staging');
        const source = join(root, 'hello');
        mkdirSync(source);
        for (const name of ['plugin.json', 'server.mjs']) copyFileSync(join(example, name), join(source, name));
        const prepared = prepareLocalPackage(source, { stagingRoot: staging, coreVersion: '9.0.0' });
        expect(prepared.manifest.id).toBe('hello');
        expect(prepared.contentSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(hashPluginDir(prepared.stagingDir)).toBe(prepared.contentSha256);
        expect(() => prepareLocalPackage(source, { stagingRoot: staging, coreVersion: '0.0.1' })).toThrow(
            /requires FatCat-AI/,
        );
    });

    it('rejects relative paths, missing directories and packages without a manifest', () => {
        const options = { stagingRoot: join(root, 'staging'), coreVersion: '0.9.0' };
        expect(() => prepareLocalPackage('relative/dir', options)).toThrow(PluginPackageError);
        expect(() => prepareLocalPackage(join(root, 'missing'), options)).toThrow(/does not exist/);
        const empty = join(root, 'empty');
        mkdirSync(empty);
        writeFileSync(join(empty, 'x.js'), '');
        expect(() => prepareLocalPackage(empty, options)).toThrow(/plugin\.json is missing/);
    });

    it('rejects an invalid manifest', () => {
        const dir = join(root, 'bad');
        mkdirSync(dir);
        writeFileSync(join(dir, 'plugin.json'), '{"id":"x"}');
        expect(() => prepareLocalPackage(dir, { stagingRoot: join(root, 'staging'), coreVersion: '0.9.0' })).toThrow(
            PluginPackageError,
        );
    });
});
