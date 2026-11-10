// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyDataDir } from './data-dir.js';

let base: string;
let from: string;
let to: string;

const exdev = () => {
    throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
};

function seedLegacy(): void {
    mkdirSync(join(from, 'backups'), { recursive: true });
    writeFileSync(join(from, 'db.sqlite'), 'database');
    writeFileSync(join(from, 'cli.json'), '{"server":"http://127.0.0.1:8787"}');
    writeFileSync(join(from, 'backups', 'db-0001.sqlite'), 'backup');
}

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'fatcat-data-dir-'));
    from = join(base, '.ai-personal');
    to = join(base, '.fatcat-ai');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('migrateLegacyDataDir', () => {
    it('没有旧目录时什么都不做', () => {
        expect(migrateLegacyDataDir(from, to)).toEqual({ action: 'none' });
        expect(existsSync(to)).toBe(false);
    });

    it('原子重命名旧目录,内容完整,只做一次', () => {
        seedLegacy();
        expect(migrateLegacyDataDir(from, to)).toEqual({ action: 'renamed' });
        expect(existsSync(from)).toBe(false);
        expect(readFileSync(join(to, 'db.sqlite'), 'utf8')).toBe('database');
        expect(readFileSync(join(to, 'backups', 'db-0001.sqlite'), 'utf8')).toBe('backup');
        expect(migrateLegacyDataDir(from, to)).toEqual({ action: 'none' });
    });

    it('新目录已存在时不覆盖,旧目录原样保留', () => {
        seedLegacy();
        mkdirSync(to);
        writeFileSync(join(to, 'db.sqlite'), 'newer');
        expect(migrateLegacyDataDir(from, to, { rename: exdev })).toEqual({ action: 'kept-existing' });
        expect(readFileSync(join(to, 'db.sqlite'), 'utf8')).toBe('newer');
        expect(existsSync(join(to, 'cli.json'))).toBe(false);
        expect(readFileSync(join(from, 'db.sqlite'), 'utf8')).toBe('database');
    });

    it('跨盘时复制、校验后删除旧目录', () => {
        seedLegacy();
        expect(migrateLegacyDataDir(from, to, { rename: exdev })).toEqual({ action: 'copied', legacyRemoved: true });
        expect(existsSync(from)).toBe(false);
        expect(readFileSync(join(to, 'db.sqlite'), 'utf8')).toBe('database');
        expect(readFileSync(join(to, 'backups', 'db-0001.sqlite'), 'utf8')).toBe('backup');
        expect(existsSync(`${to}.migrating-${process.pid}`)).toBe(false);
    });

    it('复制结果与原目录不一致时报错,旧目录不动,不留下新目录或临时目录', () => {
        seedLegacy();
        const badCopy = (src: string, dest: string) => {
            cpSync(src, dest, { recursive: true });
            writeFileSync(join(dest, 'db.sqlite'), 'truncated');
        };
        expect(() => migrateLegacyDataDir(from, to, { rename: exdev, copy: badCopy })).toThrow(/does not match/);
        expect(readFileSync(join(from, 'db.sqlite'), 'utf8')).toBe('database');
        expect(existsSync(to)).toBe(false);
        expect(existsSync(`${to}.migrating-${process.pid}`)).toBe(false);
    });

    it('其他重命名错误原样抛出,不尝试复制', () => {
        seedLegacy();
        const denied = () => {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        };
        expect(() => migrateLegacyDataDir(from, to, { rename: denied })).toThrow('permission denied');
        expect(existsSync(from)).toBe(true);
        expect(existsSync(to)).toBe(false);
    });
});
