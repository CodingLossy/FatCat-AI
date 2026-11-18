// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupData, dirSize, pruneBackups, pruneVersions, restoreData } from './plugin-files.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'fatcat-pfiles-'));
    dirs.push(dir);
    return dir;
};

describe('plugin data backup', () => {
    it('backs up, restores over later changes, and replaces an older backup of the same version', () => {
        const root = tmp();
        const data = join(root, 'weather');
        mkdirSync(join(data, 'sub'), { recursive: true });
        writeFileSync(join(data, 'a.txt'), 'one');
        writeFileSync(join(data, 'sub', 'b.txt'), 'two');
        backupData(root, 'weather', '1.0.0');
        writeFileSync(join(data, 'a.txt'), 'changed by the new version');
        writeFileSync(join(data, 'extra.txt'), 'new file');
        expect(restoreData(root, 'weather', '1.0.0')).toBe(true);
        expect(readFileSync(join(data, 'a.txt'), 'utf8')).toBe('one');
        expect(readFileSync(join(data, 'sub', 'b.txt'), 'utf8')).toBe('two');
        expect(existsSync(join(data, 'extra.txt'))).toBe(false);
        // 同一版本再备份:旧备份被替换而不是合并
        writeFileSync(join(data, 'only-now.txt'), 'x');
        rmSync(join(data, 'a.txt'));
        backupData(root, 'weather', '1.0.0');
        expect(readdirSync(join(root, '.backup', 'weather', '1.0.0')).sort()).toEqual(['only-now.txt', 'sub']);
    });

    it('restores nothing when there is no backup', () => {
        const root = tmp();
        mkdirSync(join(root, 'weather'));
        writeFileSync(join(root, 'weather', 'keep.txt'), 'data');
        expect(restoreData(root, 'weather', '9.9.9')).toBe(false);
        expect(readFileSync(join(root, 'weather', 'keep.txt'), 'utf8')).toBe('data');
    });

    it('sizes a directory, stops early above the cap, and treats a missing directory as empty', () => {
        const root = tmp();
        writeFileSync(join(root, 'a'), 'x'.repeat(10));
        mkdirSync(join(root, 'd'));
        writeFileSync(join(root, 'd', 'b'), 'y'.repeat(20));
        expect(dirSize(root)).toBe(30);
        expect(dirSize(root, 5)).toBeGreaterThan(5);
        expect(dirSize(join(root, 'missing'))).toBe(0);
    });

    it('prunes versions and backups to the ones to keep', () => {
        const root = tmp();
        for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
            mkdirSync(join(root, 'code', 'weather', v), { recursive: true });
            mkdirSync(join(root, 'data', '.backup', 'weather', v), { recursive: true });
        }
        pruneVersions(join(root, 'code'), 'weather', ['1.1.0', '1.2.0']);
        pruneBackups(join(root, 'data'), 'weather', ['1.1.0']);
        expect(readdirSync(join(root, 'code', 'weather')).sort()).toEqual(['1.1.0', '1.2.0']);
        expect(readdirSync(join(root, 'data', '.backup', 'weather'))).toEqual(['1.1.0']);
    });
});
