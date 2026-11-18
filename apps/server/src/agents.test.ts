// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { ChatChunk, ChatRequest, ModelProvider } from '@fatcat-ai/providers';
import { Agent, ProblemDetails, Run, Session } from '@fatcat-ai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, jsonBody, sessionFrom, TEST_PASSWORD, type TestServer } from './test-helpers.js';

let s: TestServer;
afterEach(async () => {
    await s?.cleanup();
});

type Script = (request: ChatRequest) => AsyncGenerator<ChatChunk>;

async function setup() {
    const steps: Script[] = [];
    const requests: ChatRequest[] = [];
    const provider: ModelProvider = {
        profileId: 'fake',
        stream: (request) => {
            requests.push(request);
            const step = steps.shift();
            if (step) return step(request);
            return (async function* (): AsyncGenerator<ChatChunk> {
                yield { type: 'text-delta', delta: 'ok' };
                yield { type: 'finish', reason: 'stop' };
            })();
        },
        test: () => Promise.resolve({ ok: true, latencyMs: 0 }),
    };
    s = await createTestServer({}, { provider, env: {} });
    const res = await s.app.request('/api/v1/auth/setup', jsonBody({ username: 'owner', password: TEST_PASSWORD }));
    const { cookie, csrf } = sessionFrom(res);
    const headers = { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' };
    const req = (path: string, init: RequestInit = {}) =>
        s.app.request(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
    const post = (path: string, body: unknown = {}) => req(path, { method: 'POST', body: JSON.stringify(body) });
    await post('/api/v1/models', {
        label: 'fake',
        kind: 'openai-compatible',
        baseURL: 'http://fake.test/v1',
        apiKeyRef: null,
        model: 'm',
        purpose: ['chat'],
    });
    const session = Session.parse(await (await post('/api/v1/sessions')).json());
    const send = (body: unknown) => post(`/api/v1/sessions/${session.id}/messages?stream=false`, body);
    const untilIdle = async () => {
        await s.runs.idle();
    };
    return { steps, requests, req, post, session, send, untilIdle };
}

const agentBody = (over: Record<string, unknown> = {}) => ({ name: 'Reader', toolSet: ['kb.search'], ...over });

describe('agents API(ADR 0042)', () => {
    it('lists the built-in roles, lets you create / edit / copy / delete your own and keeps built-ins read-only', async () => {
        const { req, post } = await setup();
        const list = (await (await req('/api/v1/agents')).json()) as { items: unknown[] };
        const agents = list.items.map((a) => Agent.parse(a));
        const roles = agents.filter((a) => a.builtin).map((a) => a.role);
        expect(roles).toEqual(
            expect.arrayContaining(['researcher', 'mail-secretary', 'file-keeper', 'schedule-assistant']),
        );
        const researcher = agents.find((a) => a.role === 'researcher')!;
        expect(researcher.systemPrompt.length).toBeGreaterThan(10);

        const created = await post('/api/v1/agents', agentBody());
        expect(created.status).toBe(201);
        const mine = Agent.parse(await created.json());
        expect(mine).toMatchObject({ builtin: false, role: 'custom', toolSet: ['kb.search'], memoryScope: 'shared' });
        expect((await post('/api/v1/agents', agentBody())).status).toBe(409);

        const patched = await req(`/api/v1/agents/${mine.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ maxSteps: 2, memoryScope: 'none' }),
        });
        expect(Agent.parse(await patched.json())).toMatchObject({ maxSteps: 2, memoryScope: 'none' });

        const builtinPatch = await req(`/api/v1/agents/${researcher.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: 'x' }),
        });
        expect(builtinPatch.status).toBe(409);
        expect(ProblemDetails.parse(await builtinPatch.json()).reason).toBe('agent_builtin');
        expect((await req(`/api/v1/agents/${researcher.id}`, { method: 'DELETE' })).status).toBe(409);

        const copy = await post(`/api/v1/agents/${researcher.id}/copy`, { name: 'My researcher' });
        expect(copy.status).toBe(201);
        expect(Agent.parse(await copy.json())).toMatchObject({ builtin: false, name: 'My researcher' });
        expect((await req(`/api/v1/agents/${mine.id}`, { method: 'DELETE' })).status).toBe(204);
        expect((await req(`/api/v1/agents/${mine.id}`)).status).toBe(404);
    });

    it('🔒 rejects unknown tools, unknown model profiles and the unsupported "own" memory scope', async () => {
        const { post } = await setup();
        const unknown = await post('/api/v1/agents', agentBody({ toolSet: ['nope.tool'] }));
        expect(unknown.status).toBe(400);
        expect(ProblemDetails.parse(await unknown.json()).reason).toBe('agent_toolset_unknown');
        expect((await post('/api/v1/agents', agentBody({ toolSet: [] }))).status).toBe(400);
        expect((await post('/api/v1/agents', agentBody({ memoryScope: 'own' }))).status).toBe(400);
        const missing = await post('/api/v1/agents', agentBody({ modelProfileId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' }));
        expect(missing.status).toBe(400);
    });

    it("🔒 only gives the model the agent's tools, and a made-up call outside the set is refused and not run", async () => {
        const { steps, requests, post, send, untilIdle, session, req } = await setup();
        const agent = Agent.parse(await (await post('/api/v1/agents', agentBody({ toolSet: ['kb.search'] }))).json());
        steps.push(async function* () {
            yield { type: 'tool-call', callId: 'c1', name: 'items.search', input: {} };
            yield { type: 'finish', reason: 'tool-calls' };
        });
        const res = await send({ text: 'hi', agentId: agent.id });
        expect(res.status).toBe(202);
        await untilIdle();
        const names = (requests[0]?.tools ?? []).map((t) => t.name);
        expect(names).toEqual(['kb.search']);
        expect(JSON.stringify(requests[1]?.messages)).toContain(
            "unknown tool: items.search (not in this agent's tool set)",
        );
        const accepted = (await res.json()) as { runId: string };
        const run = Run.parse(await (await req(`/api/v1/runs/${accepted.runId}`)).json());
        expect(run.agentId).toBe(agent.id);
        expect(session.id).toBeTruthy();
    });

    it('without an agent nothing changes, and an agent with memory "none" gets no memory tools; its persona is sent', async () => {
        const { requests, post, send, untilIdle } = await setup();
        await send({ text: 'plain' });
        await untilIdle();
        const all = (requests[0]?.tools ?? []).map((t) => t.name);
        expect(all.length).toBeGreaterThan(3);
        expect(all).toContain('memory.search');

        const agent = Agent.parse(
            await (
                await post(
                    '/api/v1/agents',
                    agentBody({
                        name: 'Quiet',
                        toolSet: ['kb.', 'memory.'],
                        memoryScope: 'none',
                        systemPrompt: 'Speak like a pirate.',
                    }),
                )
            ).json(),
        );
        await send({ text: 'arr', agentId: agent.id });
        await untilIdle();
        const names = (requests[1]?.tools ?? []).map((t) => t.name);
        expect(names.filter((n) => n.startsWith('memory.'))).toEqual([]);
        expect(names).toContain('kb.search');
        expect(JSON.stringify(requests[1]?.messages)).toContain('Speak like a pirate.');
    });

    it('regenerate keeps the agent; once the agent is deleted the run has no agent (documented in ADR 0042 6.1)', async () => {
        const { requests, post, send, untilIdle, session, req } = await setup();
        const agent = Agent.parse(await (await post('/api/v1/agents', agentBody())).json());
        const accepted = (await (await send({ text: 'hi', agentId: agent.id })).json()) as {
            runId: string;
            assistantMessageId: string;
        };
        await untilIdle();
        const regenerate = async () =>
            (await (
                await post(
                    `/api/v1/sessions/${session.id}/messages/${accepted.assistantMessageId}/regenerate?stream=false`,
                )
            ).json()) as { runId: string };
        const again = await regenerate();
        await untilIdle();
        expect(Run.parse(await (await req(`/api/v1/runs/${again.runId}`)).json()).agentId).toBe(agent.id);
        expect((requests.at(-1)?.tools ?? []).map((t) => t.name)).toEqual(['kb.search']);
        expect((await req(`/api/v1/agents/${agent.id}`, { method: 'DELETE' })).status).toBe(204);
        const third = await regenerate();
        await untilIdle();
        expect(Run.parse(await (await req(`/api/v1/runs/${third.runId}`)).json()).agentId).toBeUndefined();
    });

    it('🔒 delegates to a built-in role through the same rules: the sub-agent only gets the tools both sets share, and its run points at the parent', async () => {
        const { steps, requests, req, post, send, untilIdle } = await setup();
        const listed = (await (await req('/api/v1/agents')).json()) as { items: unknown[] };
        const researcher = listed.items.map((a) => Agent.parse(a)).find((a) => a.role === 'researcher')!;
        const lead = Agent.parse(
            await (
                await post('/api/v1/agents', agentBody({ name: 'Lead', toolSet: ['delegate', 'kb.search'] }))
            ).json(),
        );
        steps.push(
            async function* () {
                yield {
                    type: 'tool-call',
                    callId: 'c1',
                    name: 'delegate',
                    input: { agent: researcher.name, task: 'dig' },
                };
                yield { type: 'finish', reason: 'tool-calls' };
            },
            async function* () {
                yield { type: 'text-delta', delta: 'found it' };
                yield { type: 'finish', reason: 'stop' };
            },
        );
        const res = await send({ text: 'research', agentId: lead.id });
        const { runId } = (await res.json()) as { runId: string };
        await untilIdle();
        // Researcher = kb., items., web.fetch, memory.search; Lead = delegate, kb.search → shared: kb.search only
        expect((requests[1]?.tools ?? []).map((t) => t.name)).toEqual(['kb.search']);
        expect(JSON.stringify(requests[2]?.messages)).toContain('found it');
        const kids = s.repos.runs.listChildren(s.repos.owners.ids()[0]!, runId);
        expect(kids).toHaveLength(1);
        expect(kids[0]).toMatchObject({ parentRunId: runId, status: 'succeeded' });
    });

    it('🔒 while a sub-agent waits for approval the root run is the one that is reported, retried-by-id and cancelled', async () => {
        const { steps, req, post, send, session } = await setup();
        const lead = Agent.parse(
            await (
                await post('/api/v1/agents', agentBody({ name: 'Lead2', toolSet: ['delegate', 'memory.save'] }))
            ).json(),
        );
        await post('/api/v1/agents', agentBody({ name: 'Scribe2', toolSet: ['memory.save'] }));
        steps.push(
            async function* () {
                yield { type: 'tool-call', callId: 'c1', name: 'delegate', input: { agent: 'Scribe2', task: 'write' } };
                yield { type: 'finish', reason: 'tool-calls' };
            },
            async function* () {
                yield { type: 'tool-call', callId: 'c2', name: 'memory.save', input: { text: 'x' } };
                yield { type: 'finish', reason: 'tool-calls' };
            },
        );
        const first = (await (await send({ text: 'go', agentId: lead.id, clientMessageId: 'dup-1' })).json()) as {
            runId: string;
        };
        const ownerId = s.repos.owners.ids()[0]!;
        for (
            let i = 0;
            i < 200 && s.repos.approvals.list(ownerId, { limit: 5, status: 'pending' }).items.length === 0;
            i++
        ) {
            await new Promise((r) => setTimeout(r, 10));
        }
        const child = s.repos.runs.listChildren(ownerId, first.runId)[0]!;
        expect(child.status).toBe('waiting_approval');

        // (a) same clientMessageId → the root run, not the sub-run
        const again = (await (await send({ text: 'go', agentId: lead.id, clientMessageId: 'dup-1' })).json()) as {
            runId: string;
        };
        expect(again.runId).toBe(first.runId);
        // (b) a new message conflicts on the root run id, which can be cancelled
        const conflict = await send({ text: 'second' });
        expect(conflict.status).toBe(409);
        expect(JSON.stringify(await conflict.json())).toContain(first.runId);
        // a sub-run id cannot be retried on its own
        const retry = await post(`/api/v1/runs/${child.id}/retry`);
        expect(retry.status).toBe(409);
        expect(ProblemDetails.parse(await retry.json()).reason).toBe('run_is_delegated');
        // cancelling by the sub-run id stops the whole tree
        expect((await post(`/api/v1/runs/${child.id}/cancel`)).status).toBe(202);
        await s.runs.idle();
        expect(s.repos.runs.get(ownerId, first.runId)?.status).toBe('cancelled');
        expect(s.repos.runs.get(ownerId, child.id)?.status).toBe('cancelled');
        expect(session.id).toBeTruthy();
        expect(req).toBeTruthy();
    });

    it('404 for an unknown agent id on send', async () => {
        const { send } = await setup();
        expect((await send({ text: 'x', agentId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' })).status).toBe(404);
    });
});
