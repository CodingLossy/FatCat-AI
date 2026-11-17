// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// DeepSeek 偶尔不走结构化的 tool_calls,而把工具调用写成正文里的 DSML 标记,例如
//   <｜DSML｜function_calls><｜DSML｜invoke name="mail__list"><｜DSML｜parameter name="limit" string="false">5</｜DSML｜parameter>…
// 竖线可能是全角或半角、数量不固定。这里把这类标记从正文里截下来,再解析成真正的工具调用;
// 解析不了就由调用方报错,绝不把标记当正文展示(M6 真机问题 1)。

/** 标记的开头(含结束标签 `</…`)。 */
const START = /<\s*\/?\s*[|｜]+\s*DSML/;
/** 流式时可能只收到标记的一部分,末尾像标记前缀的片段先扣住,等下一段再判断。 */
const PARTIAL_TAIL = /<\s*\/?\s*[|｜]*\s*(?:D(?:S(?:M(?:L)?)?)?)?$/;
const TAG = /<\s*(\/?)\s*[|｜]+\s*DSML\s*[|｜]+\s*([A-Za-z_]*)([^>]*)>/g;

export interface DsmlCall {
    name: string;
    input: Record<string, unknown>;
}

/** 流式切分:把正文增量里的 DSML 标记扣下来,其余原样放行。 */
export class DsmlScanner {
    private held = '';
    private markup = '';
    private inMarkup = false;

    /** 返回现在可以安全展示的正文。 */
    push(delta: string): string {
        if (this.inMarkup) {
            this.markup += delta;
            return '';
        }
        const buffer = this.held + delta;
        const start = START.exec(buffer);
        if (start) {
            this.inMarkup = true;
            this.markup = buffer.slice(start.index);
            this.held = '';
            return buffer.slice(0, start.index);
        }
        const tail = PARTIAL_TAIL.exec(buffer);
        if (tail) {
            this.held = buffer.slice(tail.index);
            return buffer.slice(0, tail.index);
        }
        this.held = '';
        return buffer;
    }

    /** 流结束:返回扣住但不是标记的尾巴(应当作正文展示)与收集到的标记。 */
    end(): { text: string; markup: string } {
        const text = this.held;
        this.held = '';
        return { text, markup: this.markup };
    }
}

function attr(attrs: string, name: string): string | undefined {
    return new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs)?.[1];
}

/** 解析 DSML 标记为工具调用;格式不对(没有调用、调用没有结束、没有名字)时返回 null。 */
export function parseDsmlCalls(markup: string): DsmlCall[] | null {
    const calls: DsmlCall[] = [];
    let current: { name: string; input: Record<string, unknown>; bodyStart: number } | null = null;
    let param: { name: string; asJson: boolean; start: number } | null = null;
    for (const m of markup.matchAll(TAG)) {
        const closing = m[1] === '/';
        const kind = (m[2] ?? '').toLowerCase();
        const attrs = m[3] ?? '';
        const end = m.index + m[0].length;
        if (kind === 'invoke') {
            if (closing) {
                if (!current) return null;
                if (Object.keys(current.input).length === 0) {
                    // 参数写成 JSON 对象的变体
                    const body = markup.slice(current.bodyStart, m.index).trim();
                    if (body.startsWith('{')) {
                        try {
                            const parsed: unknown = JSON.parse(body);
                            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                                current.input = parsed as Record<string, unknown>;
                            }
                        } catch {
                            return null;
                        }
                    }
                }
                calls.push({ name: current.name, input: current.input });
                current = null;
            } else {
                const name = attr(attrs, 'name');
                if (!name || current) return null;
                current = { name, input: {}, bodyStart: end };
            }
        } else if (kind === 'parameter' && current) {
            if (closing) {
                if (!param) return null;
                const raw = markup.slice(param.start, m.index);
                let value: unknown = raw;
                if (param.asJson) {
                    try {
                        value = JSON.parse(raw);
                    } catch {
                        value = raw;
                    }
                }
                current.input[param.name] = value;
                param = null;
            } else {
                const name = attr(attrs, 'name');
                if (!name) return null;
                param = { name, asJson: attr(attrs, 'string') === 'false', start: end };
            }
        }
    }
    if (current || param || calls.length === 0) return null;
    return calls;
}
