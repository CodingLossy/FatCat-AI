// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { Item } from '@fatcat-ai/shared';
import type { Key, Translate } from './i18n.js';

// 内置的顶层分类在数据库里存的是建立时的中文名;界面按当前语言显示。其他条目(文件名、书名、会话标题)是用户数据,原样显示。
const TOP_CATEGORY: Record<string, Key> = {
    sessions: 'items.category.sessions',
    novels: 'items.category.novels',
    files: 'items.category.files',
    'characters.root': 'items.category.characters',
};

export function itemTitle(item: Pick<Item, 'kind' | 'type' | 'title'>, t: Translate): string {
    const key = item.kind === 'category' ? TOP_CATEGORY[item.type] : undefined;
    return key ? t(key) : item.title;
}
