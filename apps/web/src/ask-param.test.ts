// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { takeAskParam } from './ask-param.js';

describe('takeAskParam', () => {
    it('returns the decoded text and strips the parameter', () => {
        expect(takeAskParam('?ask=hi+there%26more')).toEqual({ text: 'hi there&more', rest: '' });
        expect(takeAskParam('?a=1&ask=x')).toEqual({ text: 'x', rest: '?a=1' });
    });

    it('leaves other queries alone and ignores blank or oversized text', () => {
        expect(takeAskParam('?a=1')).toEqual({ text: '', rest: '?a=1' });
        expect(takeAskParam('?ask=%20').text).toBe('');
        expect(takeAskParam(`?ask=${'a'.repeat(5000)}`).text).toHaveLength(2000);
    });
});
