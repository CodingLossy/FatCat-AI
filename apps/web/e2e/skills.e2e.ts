// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 技能界面(ADR 0048 第 11 节第 4 步):设置页的技能列表与内置开关、从模板建任务草稿;插件页显示纯指令插件带的
// 技能;代理页选择技能并提示「工具集不含它需要的工具」。截图用 FATCAT_SHOTS_DIR / FATCAT_SHOTS_THEME。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = join(here, '../../server/dist/index.js');
const WEB_DIST = join(here, '../dist');
const PASSWORD = 'correct horse battery staple';
const SHOTS = process.env.FATCAT_SHOTS_DIR;
const THEME = process.env.FATCAT_SHOTS_THEME;

let dir = '';
let pluginDir = '';
let server: ChildProcess | undefined;
let base = '';

async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const { port } = s.address() as AddressInfo;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
}

test.beforeAll(async () => {
    expect(existsSync(SERVER_ENTRY), 'build apps/server first').toBe(true);
    expect(existsSync(join(WEB_DIST, 'index.html')), 'build apps/web first').toBe(true);
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'fatcat-skills-e2e-')));
    // 纯指令插件:只有清单和一份说明
    pluginDir = join(dir, 'notes-plugin');
    mkdirSync(join(pluginDir, 'skills'), { recursive: true });
    writeFileSync(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({
            manifestVersion: 1,
            id: 'notes',
            version: '1.0.0',
            name: { en: 'Meeting notes', 'zh-CN': '会议纪要' },
            description: { en: 'Turns notes into minutes', 'zh-CN': '把笔记整理成会议纪要' },
            author: 'Example',
            license: 'MIT',
            engines: { fatcat: '>=1.2.0' },
            permissions: {},
            skills: [
                {
                    id: 'minutes',
                    name: { en: 'Minutes', 'zh-CN': '会议纪要' },
                    description: 'Use when the user asks to turn meeting notes into minutes',
                    instructions: 'skills/minutes.md',
                    toolSet: ['fs.read', 'fs.write'],
                },
            ],
        }),
    );
    writeFileSync(join(pluginDir, 'skills', 'minutes.md'), '# Minutes\nRead the notes, then write the minutes.');

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [SERVER_ENTRY], {
        env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            FATCAT_AI_PORT: String(port),
            FATCAT_AI_HOST: '127.0.0.1',
            FATCAT_AI_DATA_DIR: join(dir, 'data'),
            FATCAT_AI_WEB_DIR: WEB_DIST,
            FATCAT_AI_LOG_LEVEL: 'error',
        },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    for (let i = 0; i < 100; i++) {
        const ok = await fetch(`${base}/healthz`).then(
            (r) => r.ok,
            () => false,
        );
        if (ok) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not become healthy');
});

test.afterAll(async () => {
    if (server && server.exitCode === null) {
        const exited = new Promise((r) => server!.once('exit', r));
        server.kill();
        await exited;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
});

async function api(
    page: Page,
    method: string,
    path: string,
    body?: unknown,
): Promise<{ status: number; json: unknown }> {
    return page.evaluate(
        async ({ method, path, body }) => {
            const csrf = /(?:^|; )aip_csrf=([^;]*)/.exec(document.cookie)?.[1] ?? '';
            const res = await fetch(path, {
                method,
                headers: { 'content-type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: res.status, json: res.status === 204 ? null : await res.json() };
        },
        { method, path, body },
    );
}

/** 页面在主区域里滚动,截图前先把要看的部分滚进视口。 */
async function shot(page: Page, name: string, target?: Locator) {
    if (!SHOTS) return;
    if (target) {
        await target.evaluate((el) => {
            el.scrollIntoView({ block: 'start' });
            // 顶部有浮动的标题栏:再往回滚一点,别把标题压住
            let box = el.parentElement;
            while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
            box?.scrollBy(0, -96);
        });
    }
    await page.screenshot({ path: join(SHOTS, `${THEME ?? 'tech'}-${name}.png`) });
}

async function openSkillSettings(page: Page) {
    await page.goto(`${base}/settings`);
    await page.getByRole('tab', { name: /工具插件/ }).click();
    // 手机上同一分区的各项依次排开,没有子菜单
    const item = page.getByRole('button', { name: '技能', exact: true });
    if (await item.isVisible()) await item.click();
}

test('技能:设置页开关与模板、插件页的纯指令插件、代理页选择', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    await page.getByLabel('用户名').fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '创建并登录' }).click();
    await expect(page.getByRole('link', { name: '新对话' })).toBeVisible();
    if (THEME) {
        expect((await api(page, 'PUT', '/api/v1/settings', { theme: THEME })).status).toBe(200);
        await page.reload();
    }

    // 设置 → 工具插件 → 技能:三个内置技能,默认启用
    await openSkillSettings(page);
    const list = page.getByTestId('skill-list');
    await expect(list.locator('[data-skill]')).toHaveCount(3);
    const web = list.locator('[data-skill="web-research"]');
    await expect(web).toContainText('网页调研');
    await expect(web).toContainText('web.fetch, browser.');
    await expect(web.getByRole('checkbox')).toBeChecked();
    await shot(page, 'skills-settings', list);

    // 关掉网页调研:服务器里的状态跟着变
    await web.getByRole('checkbox').click();
    await expect(web.getByRole('checkbox')).not.toBeChecked();
    await expect
        .poll(async () => {
            const { json } = await api(page, 'GET', '/api/v1/skills');
            return (json as { items: { id: string; enabled: boolean }[] }).items.find((s) => s.id === 'web-research')
                ?.enabled;
        })
        .toBe(false);

    // 每日邮件摘要模板:建草稿后跳到任务页,确认前不会运行
    await list
        .locator('[data-skill="mail-assistant"]')
        .getByRole('button', { name: /建任务草稿:每日邮件摘要/ })
        .click();
    await expect(page).toHaveURL(/\/tasks$/);
    const card = page.getByTestId('task-draft');
    await expect(card).toContainText('每日邮件摘要');
    await expect(card.getByLabel('任务可用的工具')).toHaveValue('mail.list, mail.read, mail.search, mail.summarize');
    await shot(page, 'skills-task-draft', card);
    type Tasks = { items: { name: string; status: string; policy: { toolSet?: string[] } }[] };
    const daily = async () =>
        ((await api(page, 'GET', '/api/v1/tasks')).json as Tasks).items.find((x) => x.name === '每日邮件摘要');
    expect(await daily()).toMatchObject({
        status: 'draft',
        policy: { toolSet: ['mail.list', 'mail.read', 'mail.search', 'mail.summarize'] },
    });
    // 确认后任务生效,工具集仍然只有读取与总结
    await card.getByRole('button', { name: '确认并启用' }).click();
    await expect(card).toHaveCount(0);
    expect(await daily()).toMatchObject({
        status: 'active',
        policy: { toolSet: ['mail.list', 'mail.read', 'mail.search', 'mail.summarize'] },
    });

    // 插件页:纯指令插件在确认时说明不运行代码,并列出它带的技能
    await page.getByRole('link', { name: '插件' }).click();
    await page.getByLabel('插件目录', { exact: false }).fill(pluginDir);
    await page.getByRole('button', { name: '检查' }).click();
    const confirm = page.getByTestId('plugin-confirm');
    await expect(confirm).toContainText('纯指令插件:不运行任何代码,只提供说明。');
    await expect(confirm.getByTestId('plugin-skills')).toContainText('会议纪要');
    await expect(confirm.getByTestId('plugin-skills')).toContainText('fs.read, fs.write');
    await expect(confirm.getByTestId('plugin-protections')).toHaveCount(0);
    await shot(page, 'skills-plugin-confirm', confirm);
    await confirm.getByRole('checkbox').check();
    await confirm.getByRole('button', { name: '安装' }).click();
    const pluginCard = page.locator('[data-plugin="notes"]');
    await expect(pluginCard.getByTestId('plugin-skills')).toContainText('Use when the user asks to turn meeting notes');
    await expect(pluginCard).toContainText('已启用');
    // 纯指令插件:有「纯指令」标记,没有「停止」按钮;管理面板(安装后自动展开)里没有内存设置
    await expect(pluginCard.getByTestId('plugin-instruction-only')).toHaveText('纯指令');
    await expect(pluginCard.getByRole('button', { name: '停止' })).toHaveCount(0);
    await expect(pluginCard.getByTestId('plugin-manage')).toContainText('没有要运行的代码');
    await expect(pluginCard.getByTestId('plugin-protections')).toHaveCount(0);
    await shot(page, 'skills-plugin-card', pluginCard);

    // 市场页:索引带的技能与「纯指令」标记(签名索引的下载与验证由服务器测试覆盖,这里直接给出列表)
    const listing = {
        markets: [
            {
                id: 'official',
                official: true,
                state: 'ok',
                keyId: 'k1',
                serial: 1,
                fetchedAt: '2026-11-25T00:00:00Z',
                expiresAt: '2999-01-01T00:00:00Z',
                error: null,
            },
        ],
        plugins: [
            {
                market: 'official',
                id: 'minutes-kit',
                name: { en: 'Minutes kit', 'zh-CN': '纪要工具包' },
                description: { en: 'Meeting minutes skill', 'zh-CN': '整理会议纪要的技能' },
                author: 'Example',
                license: 'MIT',
                homepage: null,
                versions: [
                    {
                        version: '1.0.0',
                        engines: '>=1.2.0',
                        size: 2048,
                        publishedAt: '2026-11-20T00:00:00Z',
                        permissions: { tools: [], net: [], secrets: [] },
                        compatible: true,
                        instructionOnly: true,
                    },
                ],
                installed: null,
                skills: [{ id: 'minutes', description: 'Use when the user asks to turn meeting notes into minutes' }],
            },
        ],
    };
    await page.route(/\/api\/v1\/plugins\/market(\/refresh)?$/, (route) => route.fulfill({ json: listing }));
    await page.getByRole('tab', { name: '市场' }).click();
    const marketSkills = page.getByTestId('market-skills');
    await expect(marketSkills).toContainText('minutes');
    await expect(marketSkills).toContainText('Use when the user asks to turn meeting notes');
    await expect(page.getByTestId('market-instruction-only')).toHaveText('纯指令');
    await shot(page, 'skills-market', marketSkills.locator('xpath=..'));
    await page.unroute(/\/api\/v1\/plugins\/market(\/refresh)?$/);

    // 设置页里多了插件的技能,随插件启用或停用,没有自己的开关
    await openSkillSettings(page);
    const minutes = page.locator('[data-skill="plugin.notes.minutes"]');
    await expect(minutes).toContainText('来自插件 notes');
    await expect(minutes).toContainText('随插件启用或停用');
    await expect(minutes.getByRole('checkbox')).toHaveCount(0);

    // 代理页:工具集只有 kb. 时,本地文件可以用,邮件助手和会议纪要提示工具集不含
    await page.getByRole('link', { name: '代理' }).click();
    await page.getByRole('button', { name: '新建代理' }).click();
    const form = page.getByTestId('agent-form');
    await form.getByLabel('名称').fill('资料员');
    await form.getByLabel('可用工具').fill('kb., memory.search');
    const picker = form.getByTestId('agent-skill-picker');
    await picker.locator('[data-skill="local-files"]').getByRole('checkbox').check();
    await picker.locator('[data-skill="mail-assistant"]').getByRole('checkbox').check();
    await expect(picker.locator('[data-skill="local-files"]')).not.toContainText('工具集不含');
    await expect(picker.locator('[data-skill="mail-assistant"]')).toContainText('工具集不含它需要的工具');
    await expect(picker.locator('[data-skill="web-research"]')).toContainText('未启用');
    await shot(page, 'skills-agent-form', picker);
    await form.getByRole('button', { name: '保存' }).click();
    const agentCard = page.getByTestId('agent-card').filter({ hasText: '资料员' });
    await expect(agentCard.getByTestId('agent-skills')).toContainText('本地文件');
    await expect(agentCard.getByTestId('agent-skills')).toContainText('工具集不含它需要的工具');
    const agents = (await api(page, 'GET', '/api/v1/agents')).json as { items: { name: string; skills?: string[] }[] };
    expect(agents.items.find((a) => a.name === '资料员')?.skills).toEqual(['local-files', 'mail-assistant']);
    await shot(page, 'skills-agent-card', agentCard);

    // 手机:设置页的技能列表不横向滚动
    await page.setViewportSize({ width: 390, height: 844 });
    await openSkillSettings(page);
    await expect(page.getByTestId('skill-list').locator('[data-skill]')).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'skills-settings-mobile', page.getByTestId('skill-list'));

    // 手机:市场页的技能列表与「纯指令」标记
    await page.route(/\/api\/v1\/plugins\/market(\/refresh)?$/, (route) => route.fulfill({ json: listing }));
    await page.goto(`${base}/plugins`);
    await page.getByRole('tab', { name: '市场' }).click();
    await expect(page.getByTestId('market-skills')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'skills-market-mobile', page.getByTestId('market-skills').locator('xpath=../..'));
});
