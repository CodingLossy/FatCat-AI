// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 小型 ICU 子集(ADR 0043 第 1 节):{name}、{n, plural, one {…} other {…}}(# 代表数值)、{x, select, a {…} other {…}}。
// 不做引号转义:字典里的撇号(don't)原样输出。不支持的语法在解析时抛错,由 check:i18n 与单测在构建期发现。

export type Vars = Record<string, string | number>;

type Node =
    | { kind: 'text'; value: string }
    | { kind: 'arg'; name: string }
    | { kind: 'plural' | 'select'; name: string; options: Map<string, Node[]> };

const NAME = /^[A-Za-z_]\w*$/;

function readBlock(src: string, start: number): { text: string; end: number } {
    // src[start] 必须是 '{';返回括号内文本和闭括号之后的位置
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return { text: src.slice(start + 1, i), end: i + 1 };
    }
    throw new Error(`unbalanced '{' in message: ${src}`);
}

function parse(src: string): Node[] {
    const nodes: Node[] = [];
    let text = '';
    let i = 0;
    const flush = () => {
        if (text) nodes.push({ kind: 'text', value: text });
        text = '';
    };
    while (i < src.length) {
        const ch = src[i]!;
        if (ch === '}') throw new Error(`unexpected '}' in message: ${src}`);
        if (ch !== '{') {
            text += ch;
            i++;
            continue;
        }
        flush();
        const { text: body, end } = readBlock(src, i);
        i = end;
        const comma = body.indexOf(',');
        if (comma < 0) {
            const name = body.trim();
            if (!NAME.test(name)) throw new Error(`bad argument name '${name}' in message: ${src}`);
            nodes.push({ kind: 'arg', name });
            continue;
        }
        const name = body.slice(0, comma).trim();
        const rest = body.slice(comma + 1);
        const comma2 = rest.indexOf(',');
        if (!NAME.test(name) || comma2 < 0) throw new Error(`bad argument '${body}' in message: ${src}`);
        const type = rest.slice(0, comma2).trim();
        if (type !== 'plural' && type !== 'select') throw new Error(`unsupported type '${type}' in message: ${src}`);
        const options = new Map<string, Node[]>();
        let j = comma2 + 1;
        const opts = rest;
        for (;;) {
            while (j < opts.length && /\s/.test(opts[j]!)) j++;
            if (j >= opts.length) break;
            let k = j;
            while (k < opts.length && !/[\s{]/.test(opts[k]!)) k++;
            const key = opts.slice(j, k);
            while (k < opts.length && /\s/.test(opts[k]!)) k++;
            if (!key || opts[k] !== '{') throw new Error(`bad option in message: ${src}`);
            const block = readBlock(opts, k);
            options.set(key, parse(block.text));
            j = block.end;
        }
        if (!options.has('other')) throw new Error(`'${type}' needs an 'other' option in message: ${src}`);
        nodes.push({ kind: type, name, options });
    }
    flush();
    return nodes;
}

const cache = new Map<string, Node[]>();

/** 解析(带缓存);语法错误会抛出,供 check:i18n 使用。 */
export function compileMessage(src: string): Node[] {
    let nodes = cache.get(src);
    if (!nodes) {
        nodes = parse(src);
        cache.set(src, nodes);
    }
    return nodes;
}

function render(nodes: Node[], vars: Vars | undefined, locale: string, hash?: string): string {
    let out = '';
    for (const n of nodes) {
        if (n.kind === 'text') {
            out += hash === undefined ? n.value : n.value.replaceAll('#', hash);
        } else if (n.kind === 'arg') {
            const v = vars?.[n.name];
            out += v === undefined ? `{${n.name}}` : String(v);
        } else if (n.kind === 'select') {
            const v = String(vars?.[n.name] ?? 'other');
            out += render(n.options.get(v) ?? n.options.get('other')!, vars, locale, hash);
        } else {
            const raw = vars?.[n.name];
            const num = typeof raw === 'number' ? raw : Number(raw);
            if (!Number.isFinite(num)) {
                out += render(n.options.get('other')!, vars, locale, hash);
                continue;
            }
            const exact = n.options.get(`=${num}`);
            const cat = new Intl.PluralRules(locale).select(num);
            const chosen = exact ?? n.options.get(cat) ?? n.options.get('other')!;
            out += render(chosen, vars, locale, new Intl.NumberFormat(locale).format(num));
        }
    }
    return out;
}

export function formatMessage(src: string, vars: Vars | undefined, locale: string): string {
    return render(compileMessage(src), vars, locale);
}

/** 消息里引用的参数名(用于检查两种语言的占位符一致)。 */
export function messageArgs(src: string): string[] {
    const names = new Set<string>();
    const walk = (nodes: Node[]) => {
        for (const n of nodes) {
            if (n.kind === 'text') continue;
            names.add(n.name);
            if (n.kind !== 'arg') for (const o of n.options.values()) walk(o);
        }
    };
    walk(compileMessage(src));
    return [...names].sort();
}
