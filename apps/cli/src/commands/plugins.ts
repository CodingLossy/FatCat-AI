// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { resolve } from 'node:path';
import {
    compareSemver,
    parseSemver,
    type PluginMarketListing,
    type PluginPermissionChange,
    type PluginPrepared,
    type PluginView,
} from '@fatcat-ai/shared';
import { connect, parse, table } from '../common.js';
import { ask, isInteractive, lineReader, type Ctx, status, UsageError } from '../io.js';

const USAGE = [
    'Usage: fatcat-ai plugins list [--json]',
    '       fatcat-ai plugins market [--refresh] [--json]',
    '       fatcat-ai plugins install <directory> [--yes] [--skip-backup] [--json]',
    '       fatcat-ai plugins install --market <market-id> <plugin-id> [--version <v>] [--yes] [--skip-backup] [--json]',
    '       fatcat-ai plugins rollback <id> [--yes]',
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

const describeChange = (c: PluginPermissionChange): string => {
    switch (c.kind) {
        case 'tool':
            return `tool ${c.name} [${c.to}]`;
        case 'tool-risk':
            return `tool ${c.name}: level ${c.from} -> ${c.to}`;
        case 'tool-sends-data':
            return `tool ${c.name} now sends your data out`;
        case 'net':
            return `network ${c.name}`;
        case 'secret':
            return `secret ${c.name}`;
        default:
            return `items ${c.name}`;
    }
};

/** 按语义化版本降序比较两个版本号(不合法的排在后面)。 */
function newerFirst(a: { version: string }, b: { version: string }): number {
    const x = parseSemver(a.version);
    const y = parseSemver(b.version);
    if (x && y) return compareSemver(y, x);
    return x ? -1 : y ? 1 : 0;
}

/** 升级前给人看的权限变化与备份提示(纯函数)。 */
export function describeUpgrade(prepared: PluginPrepared): string[] {
    const upgrade = prepared.upgrade;
    if (!upgrade) return [];
    const lines = [`Upgrade ${prepared.manifest.id}: v${upgrade.fromVersion} -> v${prepared.manifest.version}`];
    if (upgrade.diff.added.length > 0) {
        lines.push('New permissions (need your approval):');
        for (const c of upgrade.diff.added) lines.push(`  + ${describeChange(c)}`);
    }
    if (upgrade.diff.removed.length > 0) {
        lines.push('Permissions that went away:');
        for (const c of upgrade.diff.removed) lines.push(`  - ${describeChange(c)}`);
    }
    if (upgrade.diff.added.length === 0 && upgrade.diff.removed.length === 0) lines.push('Permissions are unchanged.');
    lines.push(
        upgrade.backupTooLarge
            ? `Plugin data is ${(upgrade.dataBytes / 1048576).toFixed(0)} MiB, over the 500 MiB backup limit: it will NOT be backed up, and if the upgrade fails the data cannot be restored.`
            : 'Plugin data is backed up before the upgrade; if the new version fails its health check the old version and data are put back.',
    );
    return lines;
}

/** 市场列表的表格行:同一个插件取最新的、兼容的版本。 */
export function marketRows(listing: PluginMarketListing): string[][] {
    return listing.plugins.map((p) => {
        const best = [...p.versions].sort(newerFirst).find((v) => v.compatible);
        return [
            p.market,
            p.id,
            best?.version ?? (p.versions[0] ? `${p.versions[0].version} (incompatible)` : '-'),
            p.installed ? `v${p.installed.version}` : '-',
            p.author,
        ];
    });
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

/** fatcat-ai plugins:列出、市场浏览、从本地目录或市场安装 / 升级(先显示权限再确认)、回退、停止、卸载(ADR 0040 第 9 节)。 */
export async function pluginsCommand(ctx: Ctx, args: string[]): Promise<number> {
    const [sub, ...rest] = args;
    const { values, positionals } = parse(rest, {
        json: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        'purge-data': { type: 'boolean' },
        refresh: { type: 'boolean' },
        market: { type: 'string' },
        version: { type: 'string' },
        'skip-backup': { type: 'boolean' },
    });
    const { client } = connect(ctx, values.server);

    if (sub === 'list') {
        const { items } = await client.plugins.list();
        if (values.json) ctx.stdout.write(`${JSON.stringify(items)}\n`);
        else if (items.length === 0) status(ctx, 'No plugins installed');
        else table(ctx, [['ID', 'VERSION', 'STATE', 'PROCESS', 'MEMORY', 'SOURCE'], ...items.map(row)]);
        return 0;
    }
    if (sub === 'market') {
        const listing = values.refresh ? await client.plugins.refreshMarket() : await client.plugins.market();
        if (values.json) {
            ctx.stdout.write(`${JSON.stringify(listing)}\n`);
            return 0;
        }
        for (const m of listing.markets) {
            if (m.error) status(ctx, `Market ${m.id}: ${m.state} (${m.error.code}: ${m.error.message})`);
        }
        if (listing.plugins.length === 0) status(ctx, 'No plugins in the market index');
        else table(ctx, [['MARKET', 'ID', 'LATEST', 'INSTALLED', 'AUTHOR'], ...marketRows(listing)]);
        return 0;
    }
    if (sub === 'install') {
        let prepared: PluginPrepared;
        if (values.market !== undefined) {
            const id = positionals[0];
            if (!id) throw new UsageError(USAGE);
            let version = values.version;
            if (version === undefined) {
                const listing = await client.plugins.market();
                const plugin = listing.plugins.find((p) => p.market === values.market && p.id === id);
                version = plugin?.versions.filter((v) => v.compatible).sort(newerFirst)[0]?.version;
                if (!version) throw new UsageError(`No compatible version of ${id} in market ${values.market}`);
            }
            prepared = await client.plugins.prepareMarket(values.market, id, version);
        } else {
            const dir = positionals[0];
            if (!dir) throw new UsageError(USAGE);
            // 路径由服务器解析;CLI 与服务器通常在同一台机器上,相对路径先按当前目录展开
            prepared = await client.plugins.prepareLocal(resolve(dir));
        }
        for (const line of describePrepared(prepared)) status(ctx, line);
        if (prepared.installed && !prepared.upgrade) {
            status(ctx, `Already installed (v${prepared.installed.version}) and this version is not newer.`);
            status(ctx, 'Use "plugins rollback" to go back to the previous version, or remove it first.');
            return 1;
        }
        const upgrading = prepared.upgrade !== null;
        if (upgrading) {
            status(ctx, '');
            for (const line of describeUpgrade(prepared)) status(ctx, line);
        }
        const skipBackup = prepared.upgrade?.backupTooLarge === true;
        if (skipBackup && values['skip-backup'] !== true) {
            status(ctx, 'Pass --skip-backup to confirm that you want to upgrade without a backup.');
            return 1;
        }
        const question = upgrading
            ? `\nUpgrade ${prepared.manifest.id} with all of the above?`
            : `\nInstall ${prepared.manifest.id} with all of the above?`;
        if (!(await confirm(ctx, question, values.yes === true))) {
            status(ctx, 'Cancelled');
            return 1;
        }
        const view = await client.plugins.install(prepared.stagingId, { skipDataBackup: skipBackup });
        if (values.json) ctx.stdout.write(`${JSON.stringify(view)}\n`);
        else ctx.stdout.write(`${view.id}\n`);
        status(
            ctx,
            view.state === 'enabled'
                ? `${upgrading ? 'Upgraded' : 'Installed'} ${view.id} v${view.version}`
                : `${upgrading ? 'Upgraded' : 'Installed'} ${view.id} v${view.version} (${view.state}); bind its secrets in the web UI, then enable it`,
        );
        return 0;
    }
    if (sub === 'rollback') {
        const id = positionals[0];
        if (!id) throw new UsageError(USAGE);
        const detail = await client.plugins.get(id);
        if (!detail.previousVersion) {
            status(ctx, `${id} has no previous version to go back to`);
            return 1;
        }
        status(
            ctx,
            `Roll back ${id} from v${detail.version} to v${detail.previousVersion}; its data backup is restored.`,
        );
        if (!(await confirm(ctx, `Roll back ${id}?`, values.yes === true))) {
            status(ctx, 'Cancelled');
            return 1;
        }
        const view = await client.plugins.rollback(id);
        status(ctx, `Rolled back ${view.id} to v${view.version}`);
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
