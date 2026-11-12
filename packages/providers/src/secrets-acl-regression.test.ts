// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restrictToCurrentUser, SecretsWriteError, writeSecretsKey } from './secrets.js';

// 回归测试:Windows 上 mode 600 不改变 ACL,secrets.yaml 与备份需要用 icacls 去掉继承 ACE,
// 只授予当前用户。以下只改测试文件,不改业务源码。
describe('restrictToCurrentUser regression', () => {
    const path = 'C:\\Users\\me\\.fatcat-ai\\secrets.yaml';

    it('does nothing on non-Windows platforms', () => {
        for (const platform of ['linux', 'darwin'] as const) {
            let called = false;
            restrictToCurrentUser(path, {
                platform,
                username: 'theodore',
                execFile: () => {
                    called = true;
                },
            });
            expect(called).toBe(false);
        }
    });

    it('passes the username and path as separate arguments, never through a shell', () => {
        const calls: unknown[][] = [];
        const tricky = 'Dana Lee & calc';
        restrictToCurrentUser(path, {
            platform: 'win32',
            username: tricky,
            execFile: (file, args, options) => {
                calls.push([file, args, options]);
            },
        });
        expect(calls).toEqual([
            ['icacls', [path, '/inheritance:r', '/grant:r', `${tricky}:F`], { shell: false, windowsHide: true }],
        ]);
    });

    it('warns about the missing USERNAME, does not run icacls, and does not throw', () => {
        const warnings: string[] = [];
        let called = false;
        expect(() =>
            restrictToCurrentUser(path, {
                platform: 'win32',
                username: '',
                execFile: () => {
                    called = true;
                },
                onWarning: (message) => warnings.push(message),
            }),
        ).not.toThrow();
        expect(called).toBe(false);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('USERNAME');
        expect(warnings[0]).toContain('secrets.yaml');
    });

    it('warns with the error code when icacls fails, and never reports the path', () => {
        const warnings: string[] = [];
        expect(() =>
            restrictToCurrentUser(path, {
                platform: 'win32',
                username: 'theodore',
                execFile: () => {
                    throw Object.assign(new Error('boom'), { code: 'EPERM' });
                },
                onWarning: (message) => warnings.push(message),
            }),
        ).not.toThrow();
        expect(warnings[0]).toContain('EPERM');
        expect(warnings[0]).toContain('kept');
    });
});

describe('writeSecretsKey tightens ACLs on Windows', () => {
    let dir: string;
    const file = () => join(dir, 'secrets.yaml');
    const at = (s: number) => new Date(Date.UTC(2026, 10, 11, 8, 0, s));

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fatcat-secrets-acl-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('restricts the backup before the live file is replaced, then restricts the new file', () => {
        writeFileSync(file(), 'A: 1\n');
        const seen: { name: string; existed: boolean }[] = [];
        writeSecretsKey(dir, 'B', '2', at(0), {
            restrict: (target) => {
                seen.push({ name: target.split(/[\\/]/).pop()!, existed: existsSync(target) });
            },
        });
        expect(seen).toHaveLength(2);
        expect(seen[0]!.name).toMatch(/^secrets-\d{8}T\d{6}Z\.yaml$/);
        expect(seen[1]!.name).toBe('secrets.yaml');
        expect(seen.every((s) => s.existed)).toBe(true);
    });

    it('a first write (no existing file) restricts only secrets.yaml', () => {
        const seen: string[] = [];
        writeSecretsKey(dir, 'B', '2', at(0), { restrict: (target) => seen.push(target) });
        expect(seen).toEqual([file()]);
    });

    it('an EPERM from the restrict step keeps the written content and the backup', () => {
        writeFileSync(file(), 'A: 1\n');
        const warnings: string[] = [];
        writeSecretsKey(dir, 'B', '2', at(0), {
            onWarning: (m) => warnings.push(m),
            restrict: () => {
                throw Object.assign(new Error('denied'), { code: 'EPERM' });
            },
        });
        expect(readFileSync(file(), 'utf8')).toBe("A: 1\nB: '2'\n");
        expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
        expect(warnings.length).toBeGreaterThanOrEqual(1);
        expect(warnings.every((m) => m.includes('kept'))).toBe(true);
    });

    it('an unchanged value still does not call restrict or write a backup', () => {
        writeFileSync(file(), "A: '1'\n");
        const seen: string[] = [];
        expect(writeSecretsKey(dir, 'A', '1', at(0), { restrict: (t) => seen.push(t) })).toBe(false);
        expect(seen).toEqual([]);
    });

    it('an invalid value is rejected before any restrict call', () => {
        writeFileSync(file(), 'A: 1\n');
        const seen: string[] = [];
        expect(() => writeSecretsKey(dir, 'B', '', at(0), { restrict: (t) => seen.push(t) })).toThrow(
            SecretsWriteError,
        );
        expect(seen).toEqual([]);
    });
});
