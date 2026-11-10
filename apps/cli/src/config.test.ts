// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configPath } from './config.js';

let home: string;
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fatcat-cli-home-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('configPath', () => {
    it('默认在 ~/.fatcat-ai', () => {
        expect(configPath({}, home)).toBe(join(home, '.fatcat-ai', 'cli.json'));
    });

    it('旧目录还没迁移时继续用 ~/.ai-personal,迁移后用新目录', () => {
        mkdirSync(join(home, '.ai-personal'));
        expect(configPath({}, home)).toBe(join(home, '.ai-personal', 'cli.json'));
        mkdirSync(join(home, '.fatcat-ai'));
        expect(configPath({}, home)).toBe(join(home, '.fatcat-ai', 'cli.json'));
    });

    it('FATCAT_AI_CLI_CONFIG 优先', () => {
        expect(configPath({ FATCAT_AI_CLI_CONFIG: '/x/cli.json' }, home)).toBe('/x/cli.json');
    });
});
