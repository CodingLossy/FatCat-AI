// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { parse } from '../common.js';
import type { Ctx } from '../io.js';

/** ai-personal serve:设置 AIP_HOST / AIP_PORT / AIP_DATA_DIR 后加载核心服务的入口(ADR 0008)。 */
export async function serveCommand(ctx: Ctx, args: string[]): Promise<number> {
    const { values } = parse(args, {
        host: { type: 'string' },
        port: { type: 'string', short: 'p' },
        'data-dir': { type: 'string' },
    });
    if (values.host) ctx.env.AIP_HOST = values.host;
    if (values.port) ctx.env.AIP_PORT = values.port;
    if (values['data-dir']) ctx.env.AIP_DATA_DIR = values['data-dir'];
    // 服务器入口在加载时启动并自行处理 SIGINT / SIGTERM;这里一直等到进程退出
    await import('@ai-personal/server');
    return new Promise<number>(() => undefined);
}
