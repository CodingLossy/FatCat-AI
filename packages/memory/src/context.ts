// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 每轮交给模型的记忆上下文(《记忆模块补充设计》第 4.4–4.6 节):会话的第一轮注入一次 digest;
// 每轮按用户消息检索,结果装进记忆块,并去掉 digest 里已有的条目。
import type { Repositories } from '@fatcat-ai/storage';
import type { DigestBuilder } from './digest.js';
import type { Retriever, RetrieveOptions } from './retrieve.js';

export interface MemoryContextInput {
    ownerId: string;
    /** 本轮用户消息的纯文本。 */
    query: string;
    /** 是否是会话的第一轮(只有第一轮注入 digest)。 */
    firstTurn: boolean;
    contextWindow?: number | undefined;
    channel?: RetrieveOptions['channel'];
}

export interface MemoryContext {
    /** 要加进上下文的系统消息(digest、记忆块),可能为空。 */
    messages: string[];
    /** 本轮用到的记忆(digest 中的与记忆块中的),用于 memory-used 事件。 */
    ids: string[];
}

/** 查询太长时只取开头,检索输入上限 500 字符。 */
const MAX_QUERY = 500;

export function createMemoryContext(options: { repos: Repositories; retriever: Retriever; digest: DigestBuilder }) {
    const { repos, retriever, digest } = options;
    return async (input: MemoryContextInput): Promise<MemoryContext> => {
        const messages: string[] = [];
        const ids: string[] = [];
        if (input.firstTurn) {
            const d = digest.get(input.ownerId);
            if (d.body) {
                messages.push(d.body);
                ids.push(...d.ids);
            }
        }
        const query = input.query.trim().slice(0, MAX_QUERY);
        if (query) {
            const result = await retriever.retrieve(
                input.ownerId,
                { query, tokenBudget: repos.settings.get(input.ownerId).memory.blockTokens },
                {
                    excludeIds: ids,
                    ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
                    ...(input.channel ? { channel: input.channel } : {}),
                },
            );
            if (result.block) {
                messages.push(result.block);
                ids.push(...result.items.map((i) => i.id));
            }
        }
        return { messages, ids };
    };
}
