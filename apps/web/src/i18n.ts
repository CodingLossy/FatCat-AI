// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 字典、格式化与语言解析都在 @fatcat-ai/i18n(ADR 0043);这里只放 React 上下文。
import { createContext, useContext } from 'react';
import { translator, type Locale, type Translate } from '@fatcat-ai/i18n';

export { dictionaries, translator, type Key, type Locale, type Translate } from '@fatcat-ai/i18n';

export const I18nContext = createContext<{ locale: Locale; t: Translate }>({
    locale: 'zh-CN',
    t: translator('zh-CN'),
});

export const useI18n = () => useContext(I18nContext);
