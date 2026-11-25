// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import { captionTail, currentSentence, markdownToSpeech, splitForSpeech } from './speech-text.js';

describe('markdownToSpeech', () => {
    it('代码块换成提示,链接只读文字,去掉 Markdown 标记', () => {
        const md =
            '## 结果\n\n**注意**:看 [文档](https://x.test/a)。\n\n```ts\nconst a = 1;\n```\n\n- 第一项\n- `npm i`\n> 引用';
        expect(markdownToSpeech(md, '(代码已省略)')).toBe(
            '结果\n\n注意:看 文档。\n\n(代码已省略)\n第一项\nnpm i\n引用',
        );
    });

    it('snake_case 与 a__b__c 里的下划线保留,词边界上的下划线强调去掉', () => {
        expect(markdownToSpeech('调用 my_var_name 和 a__b__c,_重点_ 与 __加粗__', '')).toBe(
            '调用 my_var_name 和 a__b__c,重点 与 加粗',
        );
    });

    it('去掉标题与引用标记时不吞掉前面的空行', () => {
        expect(markdownToSpeech('第一段\n\n# 标题', '')).toBe('第一段\n\n标题');
        expect(markdownToSpeech('第一段\n\n> 引用', '')).toBe('第一段\n\n引用');
    });
});

describe('splitForSpeech', () => {
    it('识别全角的 ！？； 和英文句号,小数与网址里的点不切', () => {
        expect(splitForSpeech('第一句！第二句？第三句；第四句', 5)).toEqual([
            '第一句！',
            '第二句？',
            '第三句；',
            '第四句',
        ]);
        expect(splitForSpeech('Pi is 3.14. See example.com. Done', 20)).toEqual([
            'Pi is 3.14.',
            'See example.com.',
            'Done',
        ]);
    });

    it('按句子边界切段,每段不超过上限', () => {
        const text = '第一句。第二句!第三句?';
        expect(splitForSpeech(text, 8)).toEqual(['第一句。第二句!', '第三句?']);
        expect(splitForSpeech(text)).toEqual([text]);
    });

    it('一句超过上限时硬切', () => {
        const parts = splitForSpeech('a'.repeat(25), 10);
        expect(parts.map((p) => p.length)).toEqual([10, 10, 5]);
    });

    it('空文本没有段', () => {
        expect(splitForSpeech('  ')).toEqual([]);
    });
});

describe('captionTail', () => {
    it('keeps short text, folds whitespace, and cuts long text at a boundary near the start of the tail', () => {
        expect(captionTail('  a\n\nb  ')).toBe('a b');
        const long = `${'x'.repeat(300)}. last sentence here`;
        const tail = captionTail(long, 40);
        expect(tail.startsWith('…')).toBe(true);
        expect(tail.length).toBeLessThanOrEqual(41);
        expect(tail.endsWith('last sentence here')).toBe(true);
        // 没有边界时直接截取末尾
        expect(captionTail('y'.repeat(100), 10)).toBe(`…${'y'.repeat(10)}`);
    });
});

describe('currentSentence', () => {
    it('只取最后一句,流式回复里就是正在说的那句', () => {
        expect(currentSentence('第一句。第二句!正在说的')).toBe('正在说的');
        expect(currentSentence('Hello there. How are you?')).toBe('How are you?');
        expect(currentSentence('  只有一句  ')).toBe('只有一句');
        expect(currentSentence('')).toBe('');
        expect(currentSentence('结尾有句号。')).toBe('结尾有句号。');
    });

    it('太长时只留结尾', () => {
        const long = 'a'.repeat(300);
        expect(currentSentence(long).length).toBeLessThanOrEqual(121);
    });
});
