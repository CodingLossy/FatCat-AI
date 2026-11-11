// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import type { RunStream } from '@fatcat-ai/client';
import {
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_RECORDING_SECONDS,
    type MemoryDegradation,
    type Message,
    type ModelProfile,
    type Settings,
} from '@fatcat-ai/shared';
import {
    type ClipboardEvent,
    type DragEvent,
    type KeyboardEvent,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import { api, errorText } from './api.js';
import { useI18n } from './i18n.js';
import { effectiveProfile, prepareImage, precheck } from './images.js';
import { applyEvent, newTurn, type LiveTool, type LiveTurn } from './live-turn.js';
import { Markdown } from './Markdown.js';
import { navigate } from './router.js';
import { ToolCard } from './ToolCard.js';
import { UsedMemories } from './UsedMemories.js';
import { canRecord, type Playback, playSegments, type Recording, startRecording } from './audio.js';
import { markdownToSpeech, splitForSpeech } from './speech-text.js';
import { useAssistantState } from './use-voice.js';
import { VoiceIndicator } from './VoiceIndicator.js';

/** 按下不到这么久就松开,视为「点按开始、再点结束」的语音消息。 */
const TAP_MS = 300;

type VoiceMode = 'idle' | 'starting' | 'hold' | 'tap' | 'transcribing';

const usableFor = (p: ModelProfile, purpose: 'stt' | 'tts') =>
    p.kind === 'openai-compatible' && p.purpose.includes(purpose);

/** 空格键按住说话只在焦点不在输入控件上时生效。 */
function typingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName);
}

/** 新对话:先建会话再跳转,跳转后的 ChatView 负责发送这条消息。 */
let pendingSend: { sessionId: string; text: string; attachmentIds: string[]; previews: string[] } | null = null;

/** 输入框里待发送的图片(本地预览用 object URL)。 */
interface PendingImage {
    key: string;
    file: File;
    url: string;
}

let imageKey = 0;

/** 把保存的消息拆成工具卡片;工具结果可能在同一条或后面的消息里。 */
function toolsOf(message: Message, results: Map<string, LiveTool['result']>): LiveTool[] {
    return message.parts.flatMap((p) => {
        if (p.type !== 'tool-call') return [];
        const result = results.get(p.callId);
        return [{ callId: p.callId, name: p.name, input: p.input, ...(result ? { result } : {}) }];
    });
}

function textOf(message: Message): string {
    return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

function MessageImages({ message }: { message: Message }) {
    const { t } = useI18n();
    const images = message.parts.filter((p) => p.type === 'image');
    if (images.length === 0) return null;
    return (
        <div className="message-images">
            {images.map((p) => (
                <a key={p.attachmentId} href={api.attachments.url(p.attachmentId)} target="_blank" rel="noreferrer">
                    <img
                        src={api.attachments.url(p.attachmentId)}
                        alt={t('chat.imageAlt', { name: p.fileName })}
                        loading="lazy"
                    />
                </a>
            ))}
        </div>
    );
}

export function ChatView({
    sessionId,
    onSessionsChanged,
}: {
    sessionId: string | null;
    onSessionsChanged: () => Promise<void>;
}) {
    const { t } = useI18n();
    const [messages, setMessages] = useState<Message[]>([]);
    const [live, setLive] = useState<LiveTurn | null>(null);
    // 从邮件「问 AI」进来时预填建议的第一句话(只含邮件 id)
    const [input, setInput] = useState(() => {
        if (!sessionId) return '';
        try {
            const key = 'fatcat.prefill.' + sessionId;
            const text = sessionStorage.getItem(key) ?? '';
            sessionStorage.removeItem(key);
            return text;
        } catch {
            return '';
        }
    });
    const [error, setError] = useState<string | null>(null);
    /** 最近一轮用到的记忆;下一轮开始时清空。 */
    const [used, setUsed] = useState<{
        runId: string | null;
        ids: string[];
        degraded: MemoryDegradation[];
        omitted: number;
    } | null>(null);
    const abort = useRef<AbortController | null>(null);
    const bottom = useRef<HTMLDivElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const [images, setImages] = useState<PendingImage[]>([]);
    /** 已发送、服务器消息还没刷新前显示的预览。 */
    const [livePreviews, setLivePreviews] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);
    const [imageNotice, setImageNotice] = useState<string | null>(null);
    const [profile, setProfile] = useState<ModelProfile | null>(null);
    const [voiceConfig, setVoiceConfig] = useState<{ settings: Settings['voice']; stt: boolean; tts: boolean } | null>(
        null,
    );
    const voiceConfigRef = useRef(voiceConfig);
    useEffect(() => {
        voiceConfigRef.current = voiceConfig;
    }, [voiceConfig]);
    const { shown, report } = useAssistantState();
    /** 本端正在收音 / 朗读;优先于服务器推来的状态,并带本地电平。 */
    const [localVoice, setLocalVoice] = useState<'listening' | 'speaking' | null>(null);
    const level = useRef<number | null>(null);
    const [voiceMode, setVoiceModeState] = useState<VoiceMode>('idle');
    const mode = useRef<VoiceMode>('idle');
    const setVoiceMode = (next: VoiceMode) => {
        mode.current = next;
        setVoiceModeState(next);
    };
    const recording = useRef<Recording | null>(null);
    const pressedAt = useRef(0);
    const playback = useRef<Playback | null>(null);
    const [speakingId, setSpeakingId] = useState<string | null>(null);
    const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
    const speakRef = useRef<(id: string, markdown: string) => void>(() => undefined);

    // 当前会话实际会用的配置档:决定能不能发图片(服务器的 model_no_vision 是最后一道检查)
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const [profiles, settings, session] = await Promise.all([
                    api.models.list(),
                    api.settings.get(),
                    sessionId ? api.sessions.get(sessionId) : Promise.resolve(null),
                ]);
                if (cancelled) return;
                setProfile(effectiveProfile(profiles.items, settings, session));
                setVoiceConfig({
                    settings: settings.voice,
                    stt: canRecord() && profiles.items.some((p) => usableFor(p, 'stt')),
                    tts: profiles.items.some((p) => usableFor(p, 'tts')),
                });
            } catch {
                if (!cancelled) setProfile(null);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [sessionId]);

    const loadMessages = useCallback(async (id: string, hideRunId: string | null) => {
        const page = await api.sessions.messages(id, { limit: 200 });
        setMessages(page.items.filter((m) => !(hideRunId && m.runId === hideRunId && m.role === 'assistant')));
    }, []);

    /** 读完一次运行的事件流;结束后以服务器保存的消息为准。 */
    const consume = useCallback(
        async (id: string, stream: RunStream, turn: LiveTurn, signal: AbortSignal) => {
            let current = turn;
            setLive(current);
            setUsed(null);
            try {
                for await (const envelope of stream) {
                    current = applyEvent(current, envelope);
                    setLive(current);
                }
            } catch (e) {
                if (signal.aborted) return;
                setError(errorText(e));
            }
            if (signal.aborted) return;
            if (current.error) setError(current.error.detail ?? current.error.title);
            await loadMessages(id, null).catch(() => undefined);
            if (current.memoryIds.length > 0 || current.memoryDegraded.length > 0) {
                setUsed({
                    runId: current.runId,
                    ids: current.memoryIds,
                    degraded: current.memoryDegraded,
                    omitted: current.memoryOmitted,
                });
            }
            setLive(null);
            const voice = voiceConfigRef.current;
            if (voice?.tts && voice.settings.autoSpeak && current.text && !current.error) {
                speakRef.current(current.runId ?? 'live', current.text);
            }
            void onSessionsChanged();
        },
        [loadMessages, onSessionsChanged],
    );

    const send = useCallback(
        async (
            id: string,
            text: string,
            signal: AbortSignal,
            attachmentIds: string[] = [],
            previews: string[] = [],
        ) => {
            setError(null);
            setLivePreviews(previews);
            try {
                const body = attachmentIds.length > 0 ? { text, attachmentIds } : { text };
                await consume(id, api.sessions.send(id, body, { signal }), newTurn(text), signal);
            } finally {
                for (const url of previews) URL.revokeObjectURL(url);
                setLivePreviews([]);
            }
        },
        [consume],
    );

    useEffect(() => {
        const controller = new AbortController();
        abort.current = controller;
        if (!sessionId) return () => controller.abort();
        const { signal } = controller;
        void (async () => {
            try {
                const session = await api.sessions.get(sessionId);
                if (signal.aborted) return;
                await loadMessages(sessionId, session.activeRunId);
                if (pendingSend?.sessionId === sessionId) {
                    const { text, attachmentIds, previews } = pendingSend;
                    pendingSend = null;
                    await send(sessionId, text, signal, attachmentIds, previews);
                } else if (session.activeRunId) {
                    // 刷新或换页回来:从头补发这次运行的事件,重建进行中的一轮(ADR 0009 第 3 节)
                    const runId = session.activeRunId;
                    await consume(sessionId, api.runs.events(runId, 0, { signal }), newTurn(null, runId), signal);
                }
            } catch (e) {
                if (!signal.aborted) setError(errorText(e));
            }
        })();
        return () => controller.abort();
    }, [sessionId, loadMessages, consume, send]);

    useEffect(() => {
        bottom.current?.scrollIntoView?.({ block: 'end' });
    }, [messages, live]);

    const noVision = images.length > 0 && profile !== null && profile.vision !== true;

    const addFiles = (files: readonly File[]) => {
        const picked = files.filter((f) => f.type === '' || f.type.startsWith('image/'));
        if (picked.length === 0) return;
        setImageNotice(null);
        const next = [...images];
        for (const file of picked) {
            const check = precheck(file);
            if (check !== 'ok') {
                setImageNotice(
                    t(check === 'type' ? 'chat.imageNotSupported' : 'chat.imageTooLarge', { name: file.name }),
                );
                continue;
            }
            if (next.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
                setImageNotice(t('chat.imageTooMany', { n: MAX_ATTACHMENTS_PER_MESSAGE }));
                break;
            }
            next.push({ key: String(++imageKey), file, url: URL.createObjectURL(file) });
        }
        setImages(next);
    };

    const removeImage = (key: string) => {
        const image = images.find((i) => i.key === key);
        if (image) URL.revokeObjectURL(image.url);
        setImages(images.filter((i) => i.key !== key));
        setImageNotice(null);
    };

    const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
        const files = [...e.clipboardData.files];
        if (files.some((f) => f.type.startsWith('image/'))) {
            e.preventDefault();
            addFiles(files);
        }
    };

    const onDrop = (e: DragEvent<HTMLDivElement>) => {
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
    };

    /** 先上传图片再发消息;上传失败时图片留在输入框里,可以重试。 */
    const uploadImages = async (): Promise<{ ids: string[]; previews: string[] } | null> => {
        if (images.length === 0) return { ids: [], previews: [] };
        setUploading(true);
        try {
            const ids: string[] = [];
            for (const image of images) {
                const blob = await prepareImage(image.file);
                ids.push((await api.attachments.upload(blob, image.file.name || 'image')).id);
            }
            const previews = images.map((i) => i.url);
            setImages([]);
            return { ids, previews };
        } catch (e) {
            setError(errorText(e));
            return null;
        } finally {
            setUploading(false);
        }
    };

    /** spoken 为转写结果时直接发送它,输入框里已有的文字保留。 */
    const submit = async (spoken?: string) => {
        const text = (spoken ?? input).trim() || (images.length > 0 ? t('chat.imageDefaultText') : '');
        if (!text || live || uploading || noVision) return;
        setError(null);
        const uploaded = await uploadImages();
        if (!uploaded) return;
        if (spoken === undefined) setInput('');
        if (sessionId && abort.current) {
            await send(sessionId, text, abort.current.signal, uploaded.ids, uploaded.previews);
            return;
        }
        try {
            const session = await api.sessions.create();
            pendingSend = { sessionId: session.id, text, attachmentIds: uploaded.ids, previews: uploaded.previews };
            await onSessionsChanged();
            navigate({ name: 'session', id: session.id }, true);
        } catch (e) {
            setError(errorText(e));
        }
    };

    // ---- 语音:按住说话 / 点按录音、转写、朗读(ADR 0021) ----

    const stopSpeaking = () => playback.current?.stop();

    const speak = (id: string, markdown: string) => {
        stopSpeaking();
        const segments = splitForSpeech(markdownToSpeech(markdown, t('voice.codeOmitted')));
        if (segments.length === 0) return;
        setSpeakingId(id);
        const current = playSegments(
            segments,
            async (text, signal) => (await api.voice.speak({ text }, { signal })).blob(),
            {
                onLevel: (l) => {
                    level.current = l;
                },
                onStart: () => {
                    setLocalVoice('speaking');
                    report({ state: 'speaking', sessionId });
                },
                onError: (e) => setError(t('voice.failed', { msg: errorText(e) })),
            },
        );
        playback.current = current;
        void current.done.then(() => {
            if (playback.current !== current) return;
            playback.current = null;
            setSpeakingId(null);
            setLocalVoice(null);
            level.current = null;
            report({ state: 'idle', sessionId });
        });
    };

    const finishRecording = async () => {
        const rec = recording.current;
        if (!rec) {
            // 麦克风还在启动(例如权限弹窗):启动完成后立即结束
            if (mode.current === 'starting') setVoiceMode('idle');
            return;
        }
        recording.current = null;
        setVoiceMode('transcribing');
        setLocalVoice(null);
        level.current = null;
        report({ state: 'idle', sessionId });
        try {
            const blob = await rec.stop();
            const text = blob ? (await api.voice.transcribe(blob)).text : '';
            if (!text) {
                setVoiceNotice(t('voice.notHeard'));
            } else if (voiceConfigRef.current?.settings.autoSend && !live) {
                await submit(text);
            } else {
                setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
            }
        } catch (e) {
            setError(t('voice.failed', { msg: errorText(e) }));
        } finally {
            setVoiceMode('idle');
        }
    };

    const beginRecording = async () => {
        stopSpeaking();
        setVoiceNotice(null);
        setError(null);
        setVoiceMode('starting');
        let rec: Recording;
        try {
            rec = await startRecording(
                (l) => {
                    level.current = l;
                },
                () => {
                    setVoiceNotice(t('voice.limit', { n: MAX_RECORDING_SECONDS }));
                    void finishRecording();
                },
            );
        } catch (e) {
            setVoiceMode('idle');
            setError(t('voice.micDenied', { msg: errorText(e) }));
            return;
        }
        recording.current = rec;
        setLocalVoice('listening');
        report({ state: 'listening', sessionId });
        if (mode.current === 'idle') {
            // 启动期间已经松开
            await finishRecording();
        } else if (mode.current === 'starting') {
            setVoiceMode('hold');
        }
    };

    const pressVoice = () => {
        if (mode.current === 'tap') return void finishRecording();
        if (mode.current !== 'idle' || live) return;
        pressedAt.current = performance.now();
        void beginRecording();
    };

    const releaseVoice = () => {
        if (mode.current !== 'hold' && mode.current !== 'starting') return;
        if (performance.now() - pressedAt.current < TAP_MS) {
            if (mode.current === 'hold') setVoiceMode('tap');
            else mode.current = 'tap';
            return;
        }
        void finishRecording();
    };

    const pressRef = useRef(pressVoice);
    const releaseRef = useRef(releaseVoice);
    // 事件监听与 consume 通过 ref 调用最新的函数
    useEffect(() => {
        speakRef.current = speak;
        pressRef.current = pressVoice;
        releaseRef.current = releaseVoice;
    });
    const voiceEnabled = voiceConfig?.stt === true;

    // 空格键按住说话(焦点不在输入控件上时)
    useEffect(() => {
        if (!voiceEnabled) return;
        const down = (e: globalThis.KeyboardEvent) => {
            if (e.code !== 'Space' || e.repeat || typingTarget(e.target)) return;
            e.preventDefault();
            pressRef.current();
        };
        const up = (e: globalThis.KeyboardEvent) => {
            if (e.code !== 'Space' || typingTarget(e.target)) return;
            e.preventDefault();
            // 键盘没有「点按」:松开即结束
            pressedAt.current = 0;
            releaseRef.current();
        };
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
        };
    }, [voiceEnabled]);

    // 离开会话时停止录音与朗读,并告诉其他端
    useEffect(
        () => () => {
            recording.current?.cancel();
            recording.current = null;
            playback.current?.stop();
            playback.current = null;
            mode.current = 'idle';
        },
        [sessionId],
    );

    const indicatorState = localVoice ?? shown.state;
    const indicatorLabel = localVoice
        ? t(`voice.state.${localVoice}`)
        : (shown.label ?? t(`voice.state.${shown.state}`));

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
        }
    };

    const stop = async () => {
        if (live?.runId) await api.runs.cancel(live.runId).catch((e: unknown) => setError(errorText(e)));
    };

    const deleteSession = async () => {
        if (!sessionId || !window.confirm(t('chat.deleteConfirm'))) return;
        await api.sessions.delete(sessionId).catch((e: unknown) => setError(errorText(e)));
        await onSessionsChanged();
        navigate({ name: 'home' });
    };

    const results = new Map<string, LiveTool['result']>();
    for (const m of messages) {
        for (const p of m.parts) {
            if (p.type === 'tool-result')
                results.set(p.callId, { output: p.output, ...(p.error ? { error: p.error } : {}) });
        }
    }

    return (
        <div className="chat">
            <div className="chat-head">
                <VoiceIndicator state={indicatorState} label={indicatorLabel} level={level} />
                {sessionId ? (
                    <button type="button" className="link small" onClick={() => void deleteSession()}>
                        {t('chat.delete')}
                    </button>
                ) : null}
            </div>
            <div className="messages" data-testid="messages">
                {messages.length === 0 && !live ? <p className="muted empty">{t('chat.empty')}</p> : null}
                {messages.map((m) => (
                    <div key={m.id} className={`message ${m.role}`} data-status={m.status}>
                        {m.role === 'user' ? <p className="user-text">{textOf(m)}</p> : <Markdown text={textOf(m)} />}
                        {m.role === 'user' ? <MessageImages message={m} /> : null}
                        {toolsOf(m, results).map((tool) => (
                            <ToolCard key={tool.callId} tool={tool} />
                        ))}
                        {m.status === 'cancelled' ? <p className="small muted">{t('chat.cancelled')}</p> : null}
                        {m.role === 'assistant' && voiceConfig?.tts && textOf(m).trim() ? (
                            <button
                                type="button"
                                className="link small speak"
                                onClick={() => (speakingId === m.id ? stopSpeaking() : speak(m.id, textOf(m)))}
                            >
                                {speakingId === m.id ? t('voice.stopSpeaking') : t('voice.speak')}
                            </button>
                        ) : null}
                    </div>
                ))}
                {live?.userText ? (
                    <div className="message user">
                        <p className="user-text">{live.userText}</p>
                        {livePreviews.length > 0 ? (
                            <div className="message-images">
                                {livePreviews.map((url) => (
                                    <img key={url} src={url} alt="" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                ) : null}
                {live ? (
                    <div className="message assistant live" data-testid="live" aria-live="polite">
                        {live.text ? <Markdown text={live.text} /> : null}
                        {live.tools.map((tool) => (
                            <ToolCard key={tool.callId} tool={tool} live />
                        ))}
                        {!live.text && live.tools.length === 0 ? (
                            <p className="muted small">{t('chat.thinking')}</p>
                        ) : null}
                    </div>
                ) : null}
                {used && !live ? (
                    <UsedMemories
                        key={used.runId ?? ''}
                        runId={used.runId}
                        ids={used.ids}
                        degraded={used.degraded}
                        omitted={used.omitted}
                    />
                ) : null}
                {error ? <p className="error">{t('chat.failed', { msg: error })}</p> : null}
                {voiceNotice ? (
                    <p className="small warning" role="status">
                        {voiceNotice}
                    </p>
                ) : null}
                <div ref={bottom} />
            </div>
            {images.length > 0 || imageNotice || noVision || uploading ? (
                <div className="composer-images" data-testid="composer-images">
                    {images.length > 0 ? (
                        <ul className="image-previews">
                            {images.map((image) => (
                                <li key={image.key}>
                                    <img src={image.url} alt={t('chat.imageAlt', { name: image.file.name })} />
                                    <button
                                        type="button"
                                        className="remove-image"
                                        aria-label={t('chat.removeImage', { name: image.file.name })}
                                        onClick={() => removeImage(image.key)}
                                        disabled={uploading}
                                    >
                                        ×
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    {noVision && profile ? (
                        <p className="small warning" role="status" data-testid="no-vision">
                            {t('chat.noVision', { label: profile.label })}
                        </p>
                    ) : null}
                    {imageNotice ? (
                        <p className="small warning" role="status">
                            {imageNotice}
                        </p>
                    ) : null}
                    {uploading ? <p className="small muted">{t('chat.uploading')}</p> : null}
                </div>
            ) : null}
            <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
                <textarea
                    aria-label={t('chat.placeholder')}
                    placeholder={t('chat.placeholder')}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    rows={3}
                />
                <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    hidden
                    data-testid="image-input"
                    onChange={(e) => {
                        addFiles([...(e.target.files ?? [])]);
                        e.target.value = '';
                    }}
                />
                {voiceEnabled ? (
                    <button
                        type="button"
                        className={`voice-button${voiceMode === 'hold' || voiceMode === 'tap' ? ' recording' : ''}`}
                        title={t('voice.holdHint')}
                        aria-pressed={voiceMode === 'hold' || voiceMode === 'tap'}
                        data-testid="voice-button"
                        disabled={voiceMode === 'transcribing' || (!!live && voiceMode === 'idle')}
                        onPointerDown={(e) => {
                            e.preventDefault();
                            pressVoice();
                        }}
                        onPointerUp={releaseVoice}
                        onPointerLeave={() => {
                            if (mode.current === 'hold') void finishRecording();
                        }}
                        onKeyDown={(e) => {
                            if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
                                e.preventDefault();
                                pressVoice();
                            }
                        }}
                        onKeyUp={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                pressedAt.current = 0;
                                releaseVoice();
                            }
                        }}
                    >
                        {voiceMode === 'transcribing'
                            ? t('voice.transcribing')
                            : voiceMode === 'tap'
                              ? t('voice.tapRecording')
                              : voiceMode === 'hold'
                                ? t('voice.recording')
                                : t('voice.hold')}
                    </button>
                ) : null}
                <button
                    type="button"
                    title={t('chat.attachHint')}
                    onClick={() => fileInput.current?.click()}
                    disabled={uploading || images.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                >
                    {t('chat.attachImage')}
                </button>
                {live ? (
                    <button type="button" onClick={() => void stop()} disabled={!live.runId}>
                        {t('chat.stop')}
                    </button>
                ) : (
                    <button
                        type="button"
                        className="primary"
                        onClick={() => void submit()}
                        disabled={(!input.trim() && images.length === 0) || uploading || noVision}
                    >
                        {t('chat.send')}
                    </button>
                )}
            </div>
        </div>
    );
}
