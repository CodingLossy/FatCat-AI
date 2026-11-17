// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Task, TaskRun, TaskRunPage, TaskSchedulePreview } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(() => s?.cleanup());

async function login() {
    s = await createTestServer();
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const call = (method: string, path: string, body?: unknown, withCsrf = true) =>
        s.app.request(`/api/v1${path}`, {
            method,
            headers: {
                cookie,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                ...(withCsrf ? { 'X-CSRF-Token': csrf } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    return call;
}

describe('/api/v1/tasks', () => {
    it('列表里有内置的记忆维护系统任务;可停用、改时间;不可删除、不可改名', async () => {
        const call = await login();
        expect((await s.app.request('/api/v1/tasks')).status).toBe(401);
        const list = (await (await call('GET', '/tasks')).json()) as { items: unknown[] };
        expect(list.items).toHaveLength(2);
        // 记忆整理默认关闭(ADR 0037)
        expect(Task.parse(list.items[1])).toMatchObject({
            action: { kind: 'system', key: 'memory.sleep' },
            enabled: false,
            nextRunAt: null,
        });
        const task = Task.parse(list.items[0]);
        expect(task).toMatchObject({
            kind: 'system',
            status: 'active',
            enabled: true,
            trigger: { kind: 'cron', expression: '30 3 * * *' },
            action: { kind: 'system', key: 'memory.maintenance' },
            lastRun: null,
        });

        const off = await call('PATCH', `/tasks/${task.id}`, { enabled: false });
        expect(Task.parse(await off.json())).toMatchObject({ enabled: false, nextRunAt: null });
        const moved = await call('PATCH', `/tasks/${task.id}`, {
            enabled: true,
            trigger: { kind: 'cron', expression: '0 5 * * *' },
        });
        expect(Task.parse(await moved.json())).toMatchObject({ trigger: { expression: '0 5 * * *' } });

        expect((await call('PATCH', `/tasks/${task.id}`, { name: 'x' })).status).toBe(400);
        expect(
            (await call('PATCH', `/tasks/${task.id}`, { trigger: { kind: 'cron', expression: '* * * * * *' } })).status,
        ).toBe(400);
        expect(
            (await call('PATCH', `/tasks/${task.id}`, { trigger: { kind: 'once', at: '2030-01-01T00:00:00.000Z' } }))
                .status,
        ).toBe(400);
        expect((await call('PATCH', `/tasks/${task.id}`, {})).status).toBe(400);
        expect((await call('DELETE', `/tasks/${task.id}`)).status).toBe(409);
        expect((await call('PATCH', `/tasks/${task.id}`, { enabled: true }, false)).status).toBe(403);
        expect((await call('GET', '/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV')).status).toBe(404);
    });

    it('文件变化任务引用的授权目录被撤销后,任务带 root_revoked 警告', async () => {
        const call = await login();
        const owner = s.repos.owners.ids()[0]!;
        const root = s.repos.fsRoots.create(owner, { path: s.dir, label: 'r' });
        const created = Task.parse(
            await (
                await call('POST', '/tasks', {
                    name: 'w',
                    trigger: { kind: 'file_changed', rootId: root.id },
                    action: { kind: 'agent_prompt', prompt: 'p' },
                })
            ).json(),
        );
        expect(created.warning ?? null).toBeNull();
        s.repos.fsRoots.delete(owner, root.id);
        const after = Task.parse(await (await call('GET', `/tasks/${created.id}`)).json());
        expect(after).toMatchObject({ status: 'active', enabled: true, warning: 'root_revoked' });
    });

    it('授权还在但磁盘上的目录被删掉后,任务带 root_missing 警告,目录建回后警告消失', async () => {
        const call = await login();
        const owner = s.repos.owners.ids()[0]!;
        const dir = join(s.dir, 'watched');
        mkdirSync(dir);
        const root = s.repos.fsRoots.create(owner, { path: dir, label: 'r' });
        const created = Task.parse(
            await (
                await call('POST', '/tasks', {
                    name: 'w',
                    trigger: { kind: 'file_changed', rootId: root.id },
                    action: { kind: 'agent_prompt', prompt: 'p' },
                })
            ).json(),
        );
        const warningOf = async () => Task.parse(await (await call('GET', `/tasks/${created.id}`)).json()).warning;
        expect(await warningOf()).toBeNull();
        rmSync(dir, { recursive: true });
        expect(await warningOf()).toBe('root_missing');
        mkdirSync(dir);
        expect(await warningOf()).toBeNull();
    });

    it('手动运行写运行记录,可分页读取;预览返回用户时区下的未来触发时刻', async () => {
        const call = await login();
        const { items } = (await (await call('GET', '/tasks')).json()) as { items: Array<{ id: string }> };
        const id = items[0]!.id;
        const queued = await call('POST', `/tasks/${id}/run`);
        expect(queued.status).toBe(202);
        const run = TaskRun.parse(await queued.json());
        expect(run).toMatchObject({ taskId: id, trigger: 'manual' });
        await new Promise((r) => setTimeout(r, 50)); // 记忆维护在测试库上很快跑完
        expect((await call('POST', `/task-runs/${run.id}/cancel`)).status).toBe(409); // 已结束
        const runs = TaskRunPage.parse(await (await call('GET', `/tasks/${id}/runs?limit=1`)).json());
        expect(runs.items).toHaveLength(1);
        expect((await call('GET', `/task-runs/${run.id}`)).status).toBe(200);

        const preview = TaskSchedulePreview.parse(
            await (await call('GET', '/tasks/schedule-preview?expression=0%208%20*%20*%20*&count=3')).json(),
        );
        expect(preview.times).toHaveLength(3);
        expect((await call('GET', '/tasks/schedule-preview?expression=bad')).status).toBe(400);
    });
});
