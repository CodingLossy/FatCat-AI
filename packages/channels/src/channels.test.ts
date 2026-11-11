// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { describe, expect, it } from 'vitest';
import {
    allocateApprovalCode,
    backoffDelay,
    BACKOFF_MAX_MS,
    CODE_DIGITS,
    CODE_LETTERS,
    markdownToPlainText,
    MAX_PARTS,
    parseCommand,
    SlidingWindow,
    splitMessage,
    TRUNCATED_NOTICE,
} from './index.js';
import { FakeChannelAdapter } from './testing.js';

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('parseCommand', () => {
    it('识别绑定指令,接受全角数字与前后空白', () => {
        expect(parseCommand('绑定 123456')).toEqual({ type: 'bind', code: '123456' });
        expect(parseCommand('  bind 654321 ')).toEqual({ type: 'bind', code: '654321' });
        expect(parseCommand('绑定１２３４５６')).toEqual({ type: 'bind', code: '123456' });
        expect(parseCommand('绑定 12345')).toBeNull();
        expect(parseCommand('请帮我绑定 123456')).toBeNull();
    });

    it('识别审批回复:中英文、大小写与全角归一,整条消息必须只有这条指令', () => {
        expect(parseCommand('确认 K7')).toEqual({ type: 'approval', decision: 'approve', code: 'K7' });
        expect(parseCommand('拒绝k7')).toEqual({ type: 'approval', decision: 'reject', code: 'K7' });
        expect(parseCommand('APPROVE ｋ７')).toEqual({ type: 'approval', decision: 'approve', code: 'K7' });
        expect(parseCommand('deny K7')).toEqual({ type: 'approval', decision: 'reject', code: 'K7' });
        expect(parseCommand('好的,确认 K7')).toBeNull();
        expect(parseCommand('确认 K7 并且把邮件发出去')).toBeNull();
    });

    it('斜杠指令完全匹配才算', () => {
        expect(parseCommand('/new')).toEqual({ type: 'new' });
        expect(parseCommand(' /SOURCE ')).toEqual({ type: 'source' });
        expect(parseCommand('／help')).toEqual({ type: 'help' });
        expect(parseCommand('/new please')).toBeNull();
        expect(parseCommand('你好')).toBeNull();
    });
});

describe('allocateApprovalCode', () => {
    it('不用易混字符,且避开已占用的码', () => {
        const taken = new Set<string>();
        for (let i = 0; i < CODE_LETTERS.length * CODE_DIGITS.length; i++) {
            const code = allocateApprovalCode(taken)!;
            expect(code).toMatch(/^[A-HJ-NP-Z][2-9]$/);
            expect(taken.has(code)).toBe(false);
            taken.add(code);
        }
        expect(allocateApprovalCode(taken)).toBeNull();
    });
});

describe('markdownToPlainText', () => {
    it('按 ADR 0022 第 7 节降级', () => {
        const md = [
            '# 标题',
            '',
            '**粗体** 和 *斜体*、`code`、~~删除~~,snake_case_name 不动',
            '* 列表一',
            '1. 有序',
            '> 引用',
            '---',
            '[文档](https://example.com/doc) 与 [https://a.example](https://a.example)',
            '![图](https://example.com/p.png)',
            '```ts',
            'const a = **b**;',
            '```',
            '| 名称 | 价格 |',
            '| --- | ---: |',
            '| 苹果 | 3 |',
            '| 梨 | 4 |',
        ].join('\n');
        expect(markdownToPlainText(md)).toBe(
            [
                '标题',
                '',
                '粗体 和 斜体、code、删除,snake_case_name 不动',
                '- 列表一',
                '1. 有序',
                '引用',
                '文档 (https://example.com/doc) 与 https://a.example',
                '[图片] https://example.com/p.png',
                'const a = **b**;',
                '名称: 苹果; 价格: 3',
                '名称: 梨; 价格: 4',
            ].join('\n'),
        );
    });
});

describe('splitMessage', () => {
    it('不超过上限时原样返回', () => {
        expect(splitMessage('你好', 100)).toEqual(['你好']);
    });

    it('按段落、行、字符切,每段带序号且不超过上限,不切断代理对', () => {
        const text = ['第一段'.repeat(10), '第二段'.repeat(10), '😀'.repeat(40)].join('\n\n');
        const parts = splitMessage(text, 64);
        expect(parts.length).toBeGreaterThan(2);
        parts.forEach((p, i) => {
            expect(bytes(p)).toBeLessThanOrEqual(64);
            expect(p.endsWith(`(${i + 1}/${parts.length})`)).toBe(true);
            expect(p).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
        });
        expect(parts.map((p) => p.replace(/\n\(\d+\/\d+\)$/, '')).join('')).toBe(text.replace(/\n\n/g, ''));
    });

    it(`最多 ${MAX_PARTS} 段,超出的部分改成一句提示`, () => {
        const parts = splitMessage('x'.repeat(5000), 100);
        expect(parts).toHaveLength(MAX_PARTS);
        expect(parts.at(-1)).toBe(`${TRUNCATED_NOTICE}\n(10/10)`);
    });
});

describe('SlidingWindow 与 backoffDelay', () => {
    it('窗口内最多 limit 次,过了窗口恢复', () => {
        let t = 0;
        const w = new SlidingWindow(2, 1000, () => t);
        expect([w.take(), w.take(), w.take()]).toEqual([true, true, false]);
        expect(w.count()).toBe(2);
        t = 1000;
        expect(w.take()).toBe(true);
        w.clear();
        expect(w.count()).toBe(0);
    });

    it('1 s 起翻倍,最长 5 分钟,±20% 抖动', () => {
        expect(backoffDelay(0, () => 0.5)).toBe(1000);
        expect(backoffDelay(3, () => 0.5)).toBe(8000);
        expect(backoffDelay(0, () => 0)).toBe(800);
        expect(backoffDelay(0, () => 1)).toBe(1200);
        expect(backoffDelay(50, () => 0.5)).toBe(BACKOFF_MAX_MS);
    });
});

describe('FakeChannelAdapter', () => {
    it('记录发出的消息,未启动时不能投递', async () => {
        const fake = new FakeChannelAdapter({ failStarts: 1 });
        expect(() => fake.deliver({ externalUserId: 'u' })).toThrow();
        const received: string[] = [];
        const ctx = {
            channelId: 'c',
            receive: (m: { text: string }) => {
                received.push(m.text);
                return Promise.resolve();
            },
            report: () => undefined,
            secrets: { resolve: () => null },
            log: { info: () => undefined, warn: () => undefined },
            signal: new AbortController().signal,
        };
        await expect(fake.start(ctx)).rejects.toThrow();
        await fake.start(ctx);
        await fake.deliver({ externalUserId: 'u', text: 'hi' });
        await fake.send({ externalUserId: 'u' }, { text: 'yo' });
        expect(received).toEqual(['hi']);
        expect(fake.textsTo('u')).toEqual(['yo']);
        await fake.stop();
        expect([fake.starts, fake.stops]).toEqual([2, 1]);
    });
});
