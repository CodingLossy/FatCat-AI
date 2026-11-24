// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPluginDir, isInstructionOnlyFile, PluginPackageError, prepareLocalPackage } from './package.js';

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

    describe('instruction-only plugins (ADR 0048)', () => {
        const manifest = (patch: Record<string, unknown> = {}) => ({
            manifestVersion: 1,
            id: 'notes',
            version: '1.0.0',
            name: { en: 'Notes' },
            description: { en: 'Note-taking skill' },
            author: 'Example',
            license: 'MIT',
            engines: { fatcat: '>=1.2.0' },
            permissions: {},
            skills: [
                {
                    id: 'notes',
                    name: { en: 'Notes' },
                    description: 'Use when the user asks to take notes.',
                    instructions: 'skills/notes.md',
                    toolSet: ['kb.search', 'fs.'],
                },
            ],
            ...patch,
        });
        const options = () => ({ stagingRoot: join(root, 'staging'), coreVersion: '1.2.0' });
        const write = (files: Record<string, string | Buffer>, patch?: Record<string, unknown>): string => {
            const dir = join(root, 'src');
            mkdirSync(join(dir, 'skills'), { recursive: true });
            writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest(patch)));
            for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
            return dir;
        };

        it('installs with plugin.json, markdown and license files only', () => {
            const dir = write({ 'skills/notes.md': '# Notes\n', 'README.md': 'x', LICENSE: 'MIT', 'NOTICE.txt': 'n' });
            const prepared = prepareLocalPackage(dir, options());
            expect(prepared.manifest.entry).toBeUndefined();
            expect(prepared.manifest.skills?.[0]?.id).toBe('notes');
        });

        it('越权:rejects a package that carries code or other files', () => {
            expect(() => prepareLocalPackage(write({ 'skills/notes.md': 'x', 'run.js': '' }), options())).toThrow(
                /run\.js: a plugin without "entry" may only contain/,
            );
            rmSync(join(root, 'src'), { recursive: true });
            expect(() => prepareLocalPackage(write({ 'skills/notes.md': 'x', 'data.bin': 'x' }), options())).toThrow(
                PluginPackageError,
            );
            expect(isInstructionOnlyFile('skills/notes.md')).toBe(true);
            expect(isInstructionOnlyFile('LICENSE-APACHE')).toBe(true);
            expect(isInstructionOnlyFile('lib/index.mjs')).toBe(false);
            expect(isInstructionOnlyFile('package.json')).toBe(false);
        });

        it('checks instructions: present, at most 16 KiB, valid UTF-8', () => {
            expect(() => prepareLocalPackage(write({}), options())).toThrow(
                /instructions "skills\/notes\.md" does not exist/,
            );
            rmSync(join(root, 'src'), { recursive: true });
            expect(() =>
                prepareLocalPackage(write({ 'skills/notes.md': 'a'.repeat(16 * 1024 + 1) }), options()),
            ).toThrow(/larger than 16 KiB/);
            rmSync(join(root, 'src'), { recursive: true });
            expect(() =>
                prepareLocalPackage(write({ 'skills/notes.md': Buffer.from([0x23, 0xff, 0xfe]) }), options()),
            ).toThrow(/not valid UTF-8/);
            rmSync(join(root, 'src'), { recursive: true });
            expect(prepareLocalPackage(write({ 'skills/notes.md': '说明'.repeat(100) }), options()).manifest.id).toBe(
                'notes',
            );
        });

        it('rejects a core older than the engines floor, and instructions outside the package', () => {
            const dir = write({ 'skills/notes.md': 'x' });
            expect(() => prepareLocalPackage(dir, { ...options(), coreVersion: '1.1.0' })).toThrow(
                /requires FatCat-AI/,
            );
            rmSync(dir, { recursive: true });
            const outside = write(
                { 'skills/notes.md': 'x' },
                {
                    skills: [{ ...manifest().skills[0], instructions: '../notes.md' }],
                },
            );
            expect(() => prepareLocalPackage(outside, options())).toThrow(/plugin\.json|instructions/);
        });
    });
});
