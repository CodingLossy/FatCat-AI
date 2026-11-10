// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// calc(read):自写的递归下降解析器,不用 eval / Function(M2 方案 PR 3)。
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const MAX_EXPRESSION_LENGTH = 500;
const MAX_DEPTH = 64;

const FUNCTIONS: Record<string, { min: number; max: number; fn: (...args: number[]) => number }> = {
    sqrt: { min: 1, max: 1, fn: Math.sqrt },
    cbrt: { min: 1, max: 1, fn: Math.cbrt },
    abs: { min: 1, max: 1, fn: Math.abs },
    round: { min: 1, max: 1, fn: Math.round },
    floor: { min: 1, max: 1, fn: Math.floor },
    ceil: { min: 1, max: 1, fn: Math.ceil },
    exp: { min: 1, max: 1, fn: Math.exp },
    ln: { min: 1, max: 1, fn: Math.log },
    log: { min: 1, max: 1, fn: Math.log10 },
    log2: { min: 1, max: 1, fn: Math.log2 },
    sin: { min: 1, max: 1, fn: Math.sin },
    cos: { min: 1, max: 1, fn: Math.cos },
    tan: { min: 1, max: 1, fn: Math.tan },
    asin: { min: 1, max: 1, fn: Math.asin },
    acos: { min: 1, max: 1, fn: Math.acos },
    atan: { min: 1, max: 1, fn: Math.atan },
    pow: { min: 2, max: 2, fn: Math.pow },
    min: { min: 1, max: 100, fn: Math.min },
    max: { min: 1, max: 100, fn: Math.max },
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export class CalcError extends Error {
    override readonly name = 'CalcError';
}

type Token = { kind: 'num'; value: number } | { kind: 'id'; value: string } | { kind: 'op'; value: string };

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < source.length) {
        const c = source[i]!;
        if (/\s/.test(c)) {
            i++;
        } else if (/[0-9.]/.test(c)) {
            const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(source.slice(i));
            if (!m) throw new CalcError(`invalid number at position ${i + 1}`);
            tokens.push({ kind: 'num', value: Number(m[0]) });
            i += m[0].length;
        } else if (/[A-Za-z_]/.test(c)) {
            const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
            tokens.push({ kind: 'id', value: m[0].toLowerCase() });
            i += m[0].length;
        } else if ('+-*/%^(),'.includes(c)) {
            tokens.push({ kind: 'op', value: c });
            i++;
        } else if (c === '×' || c === '÷') {
            tokens.push({ kind: 'op', value: c === '×' ? '*' : '/' });
            i++;
        } else {
            throw new CalcError(`unexpected character "${c}" at position ${i + 1}`);
        }
    }
    return tokens;
}

/** 计算算术表达式;支持 + - * / % ^、括号、一元正负号、常用函数与常量 pi / e。 */
export function evaluate(expression: string): number {
    if (expression.length > MAX_EXPRESSION_LENGTH) {
        throw new CalcError(`the expression is longer than ${MAX_EXPRESSION_LENGTH} characters`);
    }
    const tokens = tokenize(expression);
    let pos = 0;
    let depth = 0;
    const peek = () => tokens[pos];
    const isOp = (value: string) => {
        const t = peek();
        return t?.kind === 'op' && t.value === value;
    };
    const expect = (value: string) => {
        if (!isOp(value)) throw new CalcError(`expected "${value}"`);
        pos++;
    };
    const enter = () => {
        if (++depth > MAX_DEPTH) throw new CalcError('the expression is nested too deeply');
    };

    // expr := term (('+' | '-') term)*
    function expr(): number {
        enter();
        let value = term();
        while (isOp('+') || isOp('-')) {
            const op = (tokens[pos++] as { value: string }).value;
            const right = term();
            value = op === '+' ? value + right : value - right;
        }
        depth--;
        return value;
    }
    // term := unary (('*' | '/' | '%') unary)*
    function term(): number {
        let value = unary();
        while (isOp('*') || isOp('/') || isOp('%')) {
            const op = (tokens[pos++] as { value: string }).value;
            const right = unary();
            if ((op === '/' || op === '%') && right === 0) throw new CalcError('division by zero');
            value = op === '*' ? value * right : op === '/' ? value / right : value % right;
        }
        return value;
    }
    // unary := ('+' | '-') unary | power
    function unary(): number {
        if (isOp('-') || isOp('+')) {
            const op = (tokens[pos++] as { value: string }).value;
            enter();
            const value = unary();
            depth--;
            return op === '-' ? -value : value;
        }
        return power();
    }
    // power := primary ('^' unary)?   右结合:2^3^2 = 2^9
    function power(): number {
        const base = primary();
        if (isOp('^')) {
            pos++;
            enter();
            const exponent = unary();
            depth--;
            return Math.pow(base, exponent);
        }
        return base;
    }
    // primary := number | constant | function '(' args ')' | '(' expr ')'
    function primary(): number {
        const t = peek();
        if (!t) throw new CalcError('unexpected end of expression');
        if (t.kind === 'num') {
            pos++;
            return t.value;
        }
        if (t.kind === 'id') {
            pos++;
            if (t.value in CONSTANTS && !isOp('(')) return CONSTANTS[t.value]!;
            const f = FUNCTIONS[t.value];
            if (!f) throw new CalcError(`unknown name "${t.value}"`);
            expect('(');
            const args: number[] = [];
            if (!isOp(')')) {
                args.push(expr());
                while (isOp(',')) {
                    pos++;
                    args.push(expr());
                }
            }
            expect(')');
            if (args.length < f.min || args.length > f.max) {
                throw new CalcError(`${t.value} takes ${f.min === f.max ? f.min : `${f.min}-${f.max}`} argument(s)`);
            }
            return f.fn(...args);
        }
        if (t.value === '(') {
            pos++;
            const value = expr();
            expect(')');
            return value;
        }
        throw new CalcError(`unexpected "${t.value}"`);
    }

    if (tokens.length === 0) throw new CalcError('the expression is empty');
    const result = expr();
    if (pos < tokens.length) throw new CalcError(`unexpected "${(tokens[pos] as { value: unknown }).value}"`);
    if (!Number.isFinite(result)) throw new CalcError('the result is not a finite number');
    return result;
}

const Input = z.strictObject({ expression: z.string().min(1).max(MAX_EXPRESSION_LENGTH) });

/** calc(read):精确的算术计算,避免模型心算出错。 */
export function createCalcTool(): ToolDefinition {
    return {
        name: 'calc',
        description:
            'Evaluate an arithmetic expression exactly. Supports + - * / % ^, parentheses, pi, e and the functions ' +
            'sqrt, cbrt, abs, round, floor, ceil, exp, ln, log (base 10), log2, sin, cos, tan, asin, acos, atan, ' +
            'pow, min and max. Angles are in radians.',
        parameters: {
            type: 'object',
            properties: { expression: { type: 'string', description: 'For example: (1.5 + 2) * 3^2 / sqrt(16)' } },
            required: ['expression'],
            additionalProperties: false,
        },
        risk: 'read',
        summarize: (input) => `Calculate ${String((input as { expression?: unknown } | null)?.expression ?? '')}`,
        execute: async (raw) => {
            const { expression } = Input.parse(raw);
            const result = evaluate(expression);
            // 去掉浮点误差的尾巴(0.1 + 0.2 → 0.3),保留 15 位有效数字
            return { expression, result: Number(result.toPrecision(15)) };
        },
    };
}
