// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { watchParentExit } from './parent-exit.js';

function fakeStdin() {
    const e = new EventEmitter();
    return Object.assign(e, { resume: vi.fn() });
}

describe('watchParentExit', () => {
    it('does nothing unless the env flag is 1', () => {
        const stdin = fakeStdin();
        const onParentExit = vi.fn();
        expect(watchParentExit({ env: {}, stdin, onParentExit })).toBe(false);
        stdin.emit('end');
        expect(onParentExit).not.toHaveBeenCalled();
        expect(stdin.resume).not.toHaveBeenCalled();
    });

    it('fires once when stdin closes', () => {
        const stdin = fakeStdin();
        const onParentExit = vi.fn();
        expect(watchParentExit({ env: { FATCAT_AI_EXIT_WITH_PARENT: '1' }, stdin, onParentExit })).toBe(true);
        stdin.emit('end');
        stdin.emit('close');
        expect(onParentExit).toHaveBeenCalledTimes(1);
        expect(stdin.resume).toHaveBeenCalled();
    });
});
