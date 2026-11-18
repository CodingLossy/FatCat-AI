// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { resolve } from 'node:path';
import type { PluginPrepared, PluginView } from '@fatcat-ai/shared';
import { connect, parse, table } from '../common.js';
import { ask, isInteractive, lineReader, type Ctx, status, UsageError } from '../io.js';

const USAGE = [
    'Usage: fatcat-ai plugins list [--json]',
    '       fatcat-ai plugins install <directory> [--yes] [--json]',
    '       fatcat-ai plugins stop <id>',
    '       fatcat-ai plugins remove <id> [--purge-data] [--yes]',
].join('\n');

/** 安装前给人看的清单:插件信息、要的权限、保护程度表与「未经审核」提示(纯函数,便于测试)。 */
export function describePrepared(prepared: PluginPrepared): string[] {
    const m = prepared.manifest;
    const text = (t: { en?: string | undefined; 'zh-CN'?: string | undefined }) => t.en ?? t['zh-CN'] ?? '';
    const lines = [`${m.id} v${m.version} by ${m.author} (${m.license})`, text(m.description), '', 'Permissions:'];
    const p = m.permissions;
    for (const tool of p.tools) {
        lines.push(`  tool    ${tool.name} [${tool.risk}${tool.sendsData ? ', sends your data out' : ''}]`);
    }
    for (const domain of p.net) lines.push(`  network ${domain}`);
    for (const secret of p.secrets) lines.push(`  secret  ${secret.name}${secret.required ? ' (required)' : ''}`);
    for (const category of p.items?.categories ?? []) lines.push(`  items   ${category.type}`);
    if (lines[lines.length - 1] === 'Permissions:') lines.push('  (none)');
    lines.push('', 'Protection on this platform:');
    for (const row of prepared.protections) lines.push(`  ${row.key.padEnd(18)} ${row.level.padEnd(13)} ${row.detail}`);
    if (prepared.unreviewed) {
        lines.push(
            '',
            'WARNING: local folder, unsigned and not reviewed by the marketplace. Only install plugins you trust.',
        );
    }
    return lines;
}

function row(p: PluginView): string[] {
    const rss = p.run.rssBytes === null ? '-' : `${(p.run.rssBytes / 1048576).toFixed(1)} MiB`;
    return [
        p.id,
        p.version,
        p.state,
        p.state === 'enabled' ? p.run.state : '-',
        rss,
        p.unreviewed ? 'local' : 'market',
    ];
}

async function confirm(ctx: Ctx, question: string, yes: boolean): Promise<boolean> {
    if (yes) return true;
    if (!isInteractive(ctx)) throw new UsageError('Not a terminal: pass --yes to confirm');
    const reader = lineReader(ctx);
    try {
        const answer = await ask(reader, `${question} [y/N] `);
        return answer?.trim().toLowerCase().startsWith('y') ?? false;
    } finally {
        reader.close();
    }
}

/** fatcat-ai plugins:列出、从本地目录安装(先显示权限再确认)、停止、卸载(ADR 0040 第 9 节)。 */
export async function pluginsCommand(ctx: Ctx, args: string[]): Promise<number> {
    const [sub, ...rest] = args;
    const { values, positionals } = parse(rest, {
        json: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        'purge-data': { type: 'boolean' },
    });
    const { client } = connect(ctx, values.server);

    if (sub === 'list') {
        const { items } = await client.plugins.list();
        if (values.json) ctx.stdout.write(`${JSON.stringify(items)}\n`);
        else if (items.length === 0) status(ctx, 'No plugins installed');
        else table(ctx, [['ID', 'VERSION', 'STATE', 'PROCESS', 'MEMORY', 'SOURCE'], ...items.map(row)]);
        return 0;
    }
    if (sub === 'install') {
        const dir = positionals[0];
        if (!dir) throw new UsageError(USAGE);
        // 路径由服务器解析;CLI 与服务器通常在同一台机器上,相对路径先按当前目录展开
        const prepared = await client.plugins.prepareLocal(resolve(dir));
        for (const line of describePrepared(prepared)) status(ctx, line);
        if (prepared.installed) {
            status(ctx, `Already installed (v${prepared.installed.version}); remove it first.`);
            return 1;
        }
        if (!(await confirm(ctx, `\nInstall ${prepared.manifest.id} with all of the above?`, values.yes === true))) {
            status(ctx, 'Cancelled');
            return 1;
        }
        const view = await client.plugins.install(prepared.stagingId);
        if (values.json) ctx.stdout.write(`${JSON.stringify(view)}\n`);
        else ctx.stdout.write(`${view.id}\n`);
        status(
            ctx,
            view.state === 'enabled'
                ? `Installed ${view.id} v${view.version}`
                : `Installed ${view.id} v${view.version} (${view.state}); bind its secrets in the web UI, then enable it`,
        );
        return 0;
    }
    if (sub === 'stop') {
        const id = positionals[0];
        if (!id) throw new UsageError(USAGE);
        await client.plugins.stop(id);
        status(ctx, `Stopped ${id}`);
        return 0;
    }
    if (sub === 'remove') {
        const id = positionals[0];
        if (!id) throw new UsageError(USAGE);
        const purge = values['purge-data'] === true;
        const detail = await client.plugins.get(id);
        if (detail.affectedTasks.length > 0) {
            status(ctx, 'These tasks use the plugin and will be disabled:');
            for (const task of detail.affectedTasks) status(ctx, `  ${task.name} (${task.id})`);
        }
        status(
            ctx,
            purge
                ? 'Plugin data will be deleted. It is not part of the automatic backups and cannot be recovered.'
                : 'Plugin data is kept in the plugin-data folder (it is not part of the automatic backups).',
        );
        if (!(await confirm(ctx, `Remove ${id}?`, values.yes === true))) {
            status(ctx, 'Cancelled');
            return 1;
        }
        await client.plugins.uninstall(id, purge);
        status(ctx, `Removed ${id}`);
        return 0;
    }
    throw new UsageError(USAGE);
}
