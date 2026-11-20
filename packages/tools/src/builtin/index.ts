// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ToolDefinition } from '../types.js';
import { createBrowserTools, type BrowserToolOptions } from './browser.js';
import { createCalcTool } from './calc.js';
import { createTimeTool } from './time.js';
import { createWebFetchTool, type WebFetchOptions } from './web-fetch.js';

export interface BuiltinToolOptions {
    webFetch?: WebFetchOptions;
    /** browser.open / read / screenshot(ADR 0046);不给时不注册。 */
    browser?: BrowserToolOptions;
    now?: () => Date;
    /** time 工具不传 timezone 时用的时区(用户时区,ADR 0023)。 */
    timeZoneOf?: (ownerId: string) => string;
}

/** M2 PR 3 的内置工具:time、calc(read)与 web.fetch(read,默认需审批,只能按域名预授权)。 */
export function createBuiltinTools(options: BuiltinToolOptions = {}): ToolDefinition[] {
    return [
        createTimeTool(options.now, options.timeZoneOf),
        createCalcTool(),
        createWebFetchTool(options.webFetch),
        ...(options.browser ? createBrowserTools(options.browser) : []),
    ];
}
