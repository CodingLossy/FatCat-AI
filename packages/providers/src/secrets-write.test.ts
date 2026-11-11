// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redactor } from './redact.js';
import { restrictToCurrentUser, SecretStore, SecretsWriteError, writeSecretsKey } from './secrets.js';

// ADR 0022 第 9 节:先备份、只改目标键、解析失败不写、CRLF 保持 CRLF。
describe('writeSecretsKey', () => {
    let dir: string;
    const file = () => join(dir, 'secrets.yaml');
    const backups = () => readdirSync(join(dir, 'backups')).sort();
    const at = (s: number) => new Date(Date.UTC(2026, 10, 11, 8, 0, s));

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'fatcat-secrets-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('creates the file with mode 600 and no backup when it does not exist', () => {
        expect(writeSecretsKey(dir, 'ILINK_TOKEN_A', 'tok', at(0))).toBe(true);
        expect(readFileSync(file(), 'utf8')).toBe("ILINK_TOKEN_A: 'tok'\n");
        if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600);
        expect(() => backups()).toThrow();
    });

    it('appends a new key and leaves every other byte alone, after backing up the original', () => {
        const original = '# model keys\nDEEPSEEK_API_KEY: sk-1   # main\n\nOTHER: "x y"\n';
        writeFileSync(file(), original);
        writeSecretsKey(dir, 'ILINK_TOKEN_A', 'tok:1#2', at(0));
        expect(readFileSync(file(), 'utf8')).toBe(`${original}ILINK_TOKEN_A: 'tok:1#2'\n`);
        expect(backups()).toEqual(['secrets-20261111T080000Z.yaml']);
        expect(readFileSync(join(dir, 'backups', backups()[0]!), 'utf8')).toBe(original);
        const store = new SecretStore({ dataDir: dir, env: {}, redactor: new Redactor() });
        expect(store.resolve('file:ILINK_TOKEN_A')).toBe('tok:1#2');
        expect(store.resolve('file:DEEPSEEK_API_KEY')).toBe('sk-1');
    });

    it.skipIf(process.platform === 'win32')('keeps backups at 600 even when the original is 644', () => {
        mkdirSync(join(dir, 'backups'), { mode: 0o755 }); // 数据库备份已经建好了这个目录
        writeFileSync(file(), 'A: 1\n');
        chmodSync(file(), 0o644);
        writeSecretsKey(dir, 'B', '2', at(0));
        expect(statSync(join(dir, 'backups', backups()[0]!)).mode & 0o777).toBe(0o600);
        expect(statSync(file()).mode & 0o777).toBe(0o600);
    });

    it('updates only the target line and keeps CRLF and a missing final newline', () => {
        writeFileSync(file(), 'A: 1\r\nILINK_TOKEN_A: old\r\nB: 2');
        writeSecretsKey(dir, 'ILINK_TOKEN_A', 'new', at(0));
        expect(readFileSync(file(), 'utf8')).toBe("A: 1\r\nILINK_TOKEN_A: 'new'\r\nB: 2");
    });

    it('removes only the target line', () => {
        writeFileSync(file(), 'A: 1\nILINK_TOKEN_A: old\n# keep\n');
        expect(writeSecretsKey(dir, 'ILINK_TOKEN_A', null, at(0))).toBe(true);
        expect(readFileSync(file(), 'utf8')).toBe('A: 1\n# keep\n');
        expect(writeSecretsKey(dir, 'ILINK_TOKEN_A', null, at(1))).toBe(false);
        expect(backups()).toHaveLength(1);
    });

    it('refuses to write when the file does not parse, leaving its bytes unchanged', () => {
        const broken = 'A: 1\n  nested: 2\n';
        writeFileSync(file(), broken);
        expect(() => writeSecretsKey(dir, 'ILINK_TOKEN_A', 'tok', at(0))).toThrow(SecretsWriteError);
        expect(readFileSync(file(), 'utf8')).toBe(broken);
        expect(readdirSync(dir)).toEqual(['secrets.yaml']);
    });

    it('rejects bad names and multi-line values', () => {
        expect(() => writeSecretsKey(dir, 'bad-name', 'x')).toThrow(SecretsWriteError);
        expect(() => writeSecretsKey(dir, 'A', 'x\ny')).toThrow(SecretsWriteError);
    });

    it('keeps only the five newest backups', () => {
        writeFileSync(file(), 'A: 0\n');
        for (let i = 1; i <= 7; i++) writeSecretsKey(dir, 'A', String(i), at(i));
        expect(backups()).toEqual([3, 4, 5, 6, 7].map((s) => `secrets-20261111T08000${s}Z.yaml`));
        expect(readFileSync(join(dir, 'backups', 'secrets-20261111T080007Z.yaml'), 'utf8')).toBe("A: '6'\n");
    });

    it('SecretStore.write registers the value with the redactor and resolve sees it at once', () => {
        const redactor = new Redactor();
        const store = new SecretStore({ dataDir: dir, env: {}, redactor });
        expect(store.resolve('file:T')).toBeNull();
        store.write('T', 'secret-token-123');
        expect(store.resolve('file:T')).toBe('secret-token-123');
        expect(redactor.redact('x secret-token-123 y')).not.toContain('secret-token-123');
        store.remove('T');
        expect(store.resolve('file:T')).toBeNull();
    });

    it('keeps the written file when tightening permissions throws', () => {
        writeFileSync(file(), 'A: 1\n');
        const warnings: string[] = [];
        writeSecretsKey(dir, 'B', '2', at(0), {
            onWarning: (message) => warnings.push(message),
            restrict: () => {
                throw Object.assign(new Error('icacls missing'), { code: 'ENOENT' });
            },
        });
        expect(readFileSync(file(), 'utf8')).toBe("A: 1\nB: '2'\n");
        expect(warnings.some((message) => message.includes('ENOENT') && message.includes('kept'))).toBe(true);
        expect(backups()).toHaveLength(1);
    });
});

describe('restrictToCurrentUser', () => {
    it('on win32 runs icacls without a shell, dropping inherited ACEs and granting only the current user', () => {
        const calls: unknown[][] = [];
        restrictToCurrentUser('C:\\Users\\me\\.fatcat-ai\\secrets.yaml', {
            platform: 'win32',
            username: 'theodore',
            execFile: (file, args, options) => {
                calls.push([file, args, options]);
            },
        });
        expect(calls).toEqual([
            [
                'icacls',
                ['C:\\Users\\me\\.fatcat-ai\\secrets.yaml', '/inheritance:r', '/grant:r', 'theodore:F'],
                { shell: false, windowsHide: true },
            ],
        ]);
    });

    it('warns and does not throw when icacls fails or USERNAME is missing', () => {
        const warnings: string[] = [];
        expect(() =>
            restrictToCurrentUser('C:\\secrets.yaml', {
                platform: 'win32',
                username: 'theodore',
                execFile: () => {
                    throw Object.assign(new Error('fail'), { code: 'ENOENT' });
                },
                onWarning: (message) => warnings.push(message),
            }),
        ).not.toThrow();
        expect(warnings[0]).toContain('ENOENT');
        expect(warnings[0]).toContain('kept');
        warnings.length = 0;
        restrictToCurrentUser('C:\\backups\\secrets-20261111T080000Z.yaml', {
            platform: 'win32',
            username: '',
            execFile: () => {
                throw new Error('should not run');
            },
            onWarning: (message) => warnings.push(message),
        });
        expect(warnings[0]).toContain('USERNAME');
    });

    it('does not call icacls on other platforms', () => {
        let called = false;
        restrictToCurrentUser('/tmp/secrets.yaml', {
            platform: 'linux',
            execFile: () => {
                called = true;
            },
        });
        expect(called).toBe(false);
    });
});
