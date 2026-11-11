// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentLinkError, type NewAttachment } from './attachments.js';
import { createTestDb, fakeClock, type TestDb } from './test-helpers.js';

let t: TestDb;
let clock: ReturnType<typeof fakeClock>;
beforeEach(async () => {
    clock = fakeClock();
    t = await createTestDb({ now: clock.now });
});
afterEach(() => t.cleanup());

const png: NewAttachment = { mediaType: 'image/png', bytes: 68, sha256: 'a'.repeat(64), fileName: 'cat.png' };

function userMessage(sessionId: string) {
    clock.tick();
    return t.repos.messages.append(t.ownerId, sessionId, { role: 'user', parts: [], status: 'complete' });
}

describe('attachments', () => {
    it('上传后未引用;挂到消息后不能再挂到别的消息', () => {
        const { attachments, sessions } = t.repos;
        const a = attachments.create(t.ownerId, png);
        expect(a).toMatchObject({ ...png, messageId: null });

        const session = sessions.create(t.ownerId, {});
        const m1 = userMessage(session.id);
        attachments.link(t.ownerId, [a.id], m1.id);
        expect(attachments.get(t.ownerId, a.id)?.messageId).toBe(m1.id);

        const m2 = userMessage(session.id);
        expect(() => attachments.link(t.ownerId, [a.id], m2.id)).toThrow(AttachmentLinkError);
    });

    it('一组里有一个不合法时整体回滚;别人的附件读不到也挂不上', () => {
        const { attachments, sessions } = t.repos;
        const mine = attachments.create(t.ownerId, png);
        const stranger = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
        expect(attachments.get(stranger, mine.id)).toBeNull();

        const message = userMessage(sessions.create(t.ownerId, {}).id);
        expect(() => attachments.link(stranger, [mine.id], message.id)).toThrow(AttachmentLinkError);
        const other = attachments.create(t.ownerId, png);
        expect(() =>
            t.repos.transaction(() =>
                attachments.link(t.ownerId, [other.id, '01JMISSINGMISSINGMISSINGMI'], message.id),
            ),
        ).toThrow(AttachmentLinkError);
        expect(attachments.get(t.ownerId, other.id)?.messageId).toBeNull();
        expect(attachments.get(t.ownerId, mine.id)?.messageId).toBeNull();
    });

    it('删除会话时附件行随消息删除;删除前能取出 id', () => {
        const { attachments, sessions } = t.repos;
        const session = sessions.create(t.ownerId, {});
        const a = attachments.create(t.ownerId, png);
        attachments.link(t.ownerId, [a.id], userMessage(session.id).id);

        expect(attachments.idsForSession(t.ownerId, session.id)).toEqual([a.id]);
        sessions.delete(t.ownerId, session.id);
        expect(attachments.exists(a.id)).toBe(false);
    });

    it('只删除早于截止时间且未被引用的附件', () => {
        const { attachments, sessions } = t.repos;
        const old = attachments.create(t.ownerId, png);
        const used = attachments.create(t.ownerId, png);
        attachments.link(t.ownerId, [used.id], userMessage(sessions.create(t.ownerId, {}).id).id);
        clock.tick(60_000);
        const cutoff = clock.now();
        clock.tick();
        const fresh = attachments.create(t.ownerId, png);

        expect(attachments.removeUnlinkedBefore(cutoff)).toEqual([old.id]);
        expect(attachments.exists(old.id)).toBe(false);
        expect(attachments.exists(used.id)).toBe(true);
        expect(attachments.exists(fresh.id)).toBe(true);
    });

    it('不接受白名单以外的类型', () => {
        expect(() => t.repos.attachments.create(t.ownerId, { ...png, mediaType: 'image/svg+xml' as never })).toThrow();
    });
});

describe('modelProfiles.vision', () => {
    it('勾选后读回 true;未勾选时省略', () => {
        const base = {
            label: 'v',
            kind: 'openai-compatible' as const,
            baseURL: 'http://127.0.0.1:1/v1',
            apiKeyRef: null,
            model: 'm',
            purpose: ['chat' as const],
        };
        const plain = t.repos.modelProfiles.create(t.ownerId, base);
        expect(plain).not.toHaveProperty('vision');
        const vision = t.repos.modelProfiles.replace(t.ownerId, plain.id, { ...base, vision: true });
        expect(vision?.vision).toBe(true);
    });
});
