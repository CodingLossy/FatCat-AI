// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

/** 一条 SSE 消息(只保留本协议用到的字段)。 */
export interface SseMessage {
    id?: string;
    event: string;
    data: string;
}

/**
 * 按 WHATWG 规范解析 text/event-stream:支持 LF / CR / CRLF 换行、多行 data、注释行(心跳)与任意分块。
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let data: string[] = [];
    let event = '';
    let id: string | undefined;
    let finished = false;

    const dispatch = (): SseMessage | null => {
        if (data.length === 0) {
            event = '';
            return null;
        }
        const message: SseMessage = { event: event || 'message', data: data.join('\n') };
        if (id !== undefined) message.id = id;
        data = [];
        event = '';
        return message;
    };

    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                finished = true;
                break;
            }
            buffer += value;
            for (;;) {
                const match = /\r\n|\r|\n/.exec(buffer);
                if (!match) break;
                // 末尾单独的 \r 可能是 \r\n 的前半,等下一块再判断
                if (match[0] === '\r' && match.index === buffer.length - 1) break;
                const line = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);
                if (line === '') {
                    const message = dispatch();
                    if (message) yield message;
                    continue;
                }
                if (line.startsWith(':')) continue;
                const colon = line.indexOf(':');
                const field = colon === -1 ? line : line.slice(0, colon);
                let fieldValue = colon === -1 ? '' : line.slice(colon + 1);
                if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
                if (field === 'data') data.push(fieldValue);
                else if (field === 'event') event = fieldValue;
                else if (field === 'id' && !fieldValue.includes('\0')) id = fieldValue;
            }
        }
    } finally {
        // 调用方提前停止时取消底层请求,避免连接一直挂着
        if (!finished) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    // 流结束时未以空行结尾的消息按规范丢弃
}
