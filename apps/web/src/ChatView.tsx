// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

import { Avatar } from './Avatar.js';
import { takeAskParam } from './ask-param.js';
import type { RunStream } from '@fatcat-ai/client';
import {
    DEFAULT_SILENCE_END_SECONDS,
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_RECORDING_SECONDS,
    type Agent,
    type AssistantState,
    type MemoryDegradation,
    type Message,
    type ModelProfile,
    type Settings,
} from '@fatcat-ai/shared';
import {
    type ClipboardEvent,
    type DragEvent,
    type KeyboardEvent,
    type MutableRefObject,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import { cachedMessages, isOffline, refreshCache } from './cache.js';
import { api, errorText } from './api.js';
import { DelegationTree } from './DelegationTree.js';
import { useI18n } from './i18n.js';
import { effectiveProfile, prepareImage, precheck } from './images.js';
import { applyEvent, newTurn, type LiveTool, type LiveTurn } from './live-turn.js';
import { Markdown } from './Markdown.js';
import { navigate, routePath } from './router.js';
import { ToolCard } from './ToolCard.js';
import { UsedMemories } from './UsedMemories.js';
import { canRecord, type Playback, playSegments, type Recording, startRecording } from './audio.js';
import {
    attachConversation,
    conversationState,
    endConversation,
    startConversation,
    useConversation,
    type ConversationEnd,
} from './conversation.js';
import { currentSentence, markdownToSpeech, splitForSpeech } from './speech-text.js';
import { useAssistantState } from './use-voice.js';
import { VoiceIndicator } from './VoiceIndicator.js';
import { LevelBar } from './LevelBar.js';

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

/** 工作台读取的这一轮对话,用来画 RUNNING TOOLS、文件树和模型胶囊。 */
export interface ChatActivity {
    messages: Message[];
    live: LiveTurn | null;
    profile: ModelProfile | null;
    profiles: ModelProfile[];
    agents: Agent[];
    agentId: string;
    chooseAgent: (id: string) => void;
    /** 语音优先的极简主界面正在显示(ADR 0049 第 10 节):工作台据此收起侧栏、胶囊和底部标签。 */
    minimal: boolean;
}

/** 输入框里待发送的图片;`url`(object URL)只用于发送后消息里的临时预览,输入框缩略图不用它。 */
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

/** 缩略图的边长(CSS 像素 72,按 2 倍像素密度绘制)。 */
const THUMB = 144;

/**
 * 输入框里待发送图片的缩略图:解码成位图后画在 canvas 上,不经过 img 的 src,也不再为它创建 object URL。
 * 按「cover」居中裁成正方形;文件名只进 aria-label(React 会转义)。
 */
function ComposerPreview({ file }: { file: File }) {
    const { t } = useI18n();
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        let cancelled = false;
        let bitmap: ImageBitmap | null = null;
        void createImageBitmap(file)
            .then((decoded) => {
                bitmap = decoded;
                const el = canvas.current;
                const ctx = el?.getContext('2d');
                if (cancelled || !ctx) return;
                const side = Math.min(decoded.width, decoded.height);
                ctx.drawImage(
                    decoded,
                    (decoded.width - side) / 2,
                    (decoded.height - side) / 2,
                    side,
                    side,
                    0,
                    0,
                    THUMB,
                    THUMB,
                );
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
            bitmap?.close();
        };
    }, [file]);
    return (
        <canvas
            ref={canvas}
            role="img"
            width={THUMB}
            height={THUMB}
            aria-label={t('chat.imageAlt', { name: file.name })}
        />
    );
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
    workbench = false,
    profileEpoch = 0,
    onActivity,
    askRef,
}: {
    sessionId: string | null;
    onSessionsChanged: () => Promise<void>;
    /** 放进工作台左侧舞台时加上布局类,球由样式放大。 */
    workbench?: boolean;
    /** 顶栏换了模型之后加一,让这里重新读配置档。 */
    profileEpoch?: number;
    onActivity?: (activity: ChatActivity) => void;
    /** 全局搜索把一句话发到当前会话。 */
    askRef?: MutableRefObject<((text: string) => Promise<void>) | null>;
}) {
    const { t } = useI18n();
    const [messages, setMessages] = useState<Message[]>([]);
    const [live, setLive] = useState<LiveTurn | null>(null);
    // 从邮件「问 AI」进来时预填建议的第一句话(只含邮件 id)
    const [input, setInput] = useState(() => {
        if (!sessionId) {
            // 桌面深链接 fatcat-ai://ask?text=...:只预填,不自动发送。
            const { text, rest } = takeAskParam(window.location.search);
            if (text) window.history.replaceState(null, '', window.location.pathname + rest);
            return text;
        }
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
    // 会话地图的「分叉点」链接:/s/<id>?m=<消息 id> 滚动到该消息并短暂高亮,然后去掉参数。
    const located = useRef(false);
    useEffect(() => {
        if (located.current || messages.length === 0) return;
        const id = new URLSearchParams(window.location.search).get('m');
        if (!id) return;
        located.current = true;
        window.history.replaceState(null, '', window.location.pathname);
        const el = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
        el?.scrollIntoView?.({ block: 'center' });
        el?.classList.add('located');
        setTimeout(() => el?.classList.remove('located'), 2500);
    }, [messages]);
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
    // 代理选择(ADR 0042):记在本浏览器里;不选就是不用代理
    const [agents, setAgents] = useState<Agent[]>([]);
    const [agentId, setAgentId] = useState(() => {
        try {
            return localStorage.getItem('fatcat.agentId') ?? '';
        } catch {
            return '';
        }
    });
    const agentIdRef = useRef(agentId);
    useEffect(() => {
        agentIdRef.current = agentId;
    }, [agentId]);
    useEffect(() => {
        api.agents.list().then(
            (page) => {
                setAgents(page.items);
                // 记住的代理已被删除时回到「不使用代理」
                setAgentId((old) => (old && !page.items.some((a) => a.id === old) ? '' : old));
            },
            () => undefined,
        );
    }, []);
    const chooseAgent = useCallback((id: string) => {
        setAgentId(id);
        try {
            localStorage.setItem('fatcat.agentId', id);
        } catch {
            // 存不了也不影响使用
        }
    }, []);
    const [images, setImages] = useState<PendingImage[]>([]);
    /** 已发送、服务器消息还没刷新前显示的预览。 */
    const [livePreviews, setLivePreviews] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);
    const [imageNotice, setImageNotice] = useState<string | null>(null);
    const [profile, setProfile] = useState<ModelProfile | null>(null);
    const [profiles, setProfiles] = useState<ModelProfile[]>([]);
    const [voiceConfig, setVoiceConfig] = useState<{ settings: Settings['voice']; stt: boolean; tts: boolean } | null>(
        null,
    );
    const voiceConfigRef = useRef(voiceConfig);
    useEffect(() => {
        voiceConfigRef.current = voiceConfig;
    }, [voiceConfig]);
    const { shown, report } = useAssistantState();
    /** 本端正在收音 / 朗读;优先于服务器推来的状态,并带本地电平。 */
    // 新会话的聊天页接上时连续对话可能仍开着:状态行接着显示「正在听」
    const [localVoice, setLocalVoice] = useState<'listening' | 'speaking' | null>(() =>
        conversationState().active ? 'listening' : null,
    );
    const level = useRef<number | null>(null);
    const [voiceMode, setVoiceModeState] = useState<VoiceMode>('idle');
    const mode = useRef<VoiceMode>('idle');
    const setVoiceMode = (next: VoiceMode) => {
        mode.current = next;
        setVoiceModeState(next);
    };
    const recording = useRef<Recording | null>(null);
    /** 每次开始录音加一;取消时也加一,麦克风启动完成时代号不符就丢掉这次录音。 */
    const recordingGeneration = useRef(0);
    const pressedAt = useRef(0);
    const playback = useRef<Playback | null>(null);
    const [speakingId, setSpeakingId] = useState<string | null>(null);
    const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
    const speakRef = useRef<(id: string, markdown: string) => void>(() => undefined);
    // 语音优先(ADR 0049 第 1 节):文字输入弹窗与「查看完整对话」
    const [popupOpen, setPopupOpen] = useState(false);
    const popupOpenRef = useRef(popupOpen);
    useEffect(() => {
        popupOpenRef.current = popupOpen;
    }, [popupOpen]);
    const [showHistory, setShowHistory] = useState(false);
    const textarea = useRef<HTMLTextAreaElement>(null);
    // 连续对话(ADR 0049 第 2 节):麦克风由 conversation.ts 管,这里只管转写、排队发送和朗读
    const conversation = useConversation();
    const liveRef = useRef<LiveTurn | null>(null);
    useEffect(() => {
        liveRef.current = live;
    }, [live]);
    /** 运行还没结束时说完的段落,按顺序排队,运行结束后一条条发送。 */
    const spokenQueueRef = useRef<string[]>([]);
    const transcribing = useRef(0);

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
                setProfiles(profiles.items);
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
    }, [sessionId, profileEpoch]);

    const loadMessages = useCallback(async (id: string, hideRunId: string | null) => {
        let items: Message[];
        try {
            items = (await api.sessions.messages(id, { limit: 200 })).items;
            void refreshCache();
        } catch (error) {
            // 连不上服务器时显示离线缓存里的消息(只读)
            if (!isOffline(error)) throw error;
            items = await cachedMessages(id);
            if (items.length === 0) throw error;
        }
        setMessages(items.filter((m) => !(hideRunId && m.runId === hideRunId && m.role === 'assistant')));
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
            // 连续对话里回复总是朗读(有朗读配置档时);已经有排队的下一句时不读这条旧回复
            const wantSpeak = voice?.settings.autoSpeak || conversationState().active;
            if (voice?.tts && wantSpeak && spokenQueueRef.current.length === 0 && current.text && !current.error) {
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
                const body = {
                    text,
                    ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
                    ...(agentIdRef.current ? { agentId: agentIdRef.current } : {}),
                };
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
        if (spoken === undefined) {
            setInput('');
            // 从文字弹窗发出后收起,回到语音界面
            setPopupOpen(false);
        }
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
            level.current = null;
            // 连续对话里读完(或被打断)后回到「正在听」
            const listening = conversationState().active;
            setLocalVoice(listening ? 'listening' : null);
            report({ state: listening ? 'listening' : 'idle', sessionId });
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
                // 不自动发送时,语音界面打开文字弹窗,让用户看到转写结果再发
                if (voiceConfigRef.current?.settings.inputMode === 'voice') setPopupOpen(true);
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
        const generation = ++recordingGeneration.current;
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
            if (generation !== recordingGeneration.current) return;
            setVoiceMode('idle');
            setError(t('voice.micDenied', { msg: errorText(e) }));
            return;
        }
        if (generation !== recordingGeneration.current) {
            // 麦克风启动期间按了 Esc:丢掉这次录音,不转写也不发送
            rec.cancel();
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
        } else if (mode.current === 'tap') {
            // 麦克风启动期间已经点按松开:显示「再点一下结束」
            setVoiceMode('tap');
        }
    };

    const pressVoice = () => {
        // 连续对话开着时麦克风已经在听,不再另外录音
        if (conversationState().active) return;
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

    /** 录音中按 Esc:丢掉这次录音,不转写也不发送。 */
    const cancelRecording = () => {
        if (mode.current !== 'hold' && mode.current !== 'tap' && mode.current !== 'starting') return false;
        recordingGeneration.current++;
        recording.current?.cancel();
        recording.current = null;
        setVoiceMode('idle');
        setLocalVoice(null);
        level.current = null;
        report({ state: 'idle', sessionId });
        setVoiceNotice(t('voice.cancelled'));
        return true;
    };

    // 运行结束后发送排队的下一句
    const flushQueue = () => {
        const [next, ...rest] = spokenQueueRef.current;
        if (next === undefined) return;
        spokenQueueRef.current = rest;
        void submit(next);
    };
    const flushRef = useRef(flushQueue);
    /** 连续对话录完一段:转写后发送;运行还没结束时排队。 */
    const handleSegment = async (blob: Blob) => {
        transcribing.current++;
        try {
            const text = (await api.voice.transcribe(blob)).text;
            if (!text || !conversationState().active) return;
            setVoiceNotice(null);
            if (liveRef.current || spokenQueueRef.current.length > 0) {
                spokenQueueRef.current = [...spokenQueueRef.current, text];
                // 运行在转写期间已经结束:这里直接发出队首
                if (!liveRef.current) flushQueue();
            } else {
                await submit(text);
            }
        } catch (e) {
            setError(t('voice.failed', { msg: errorText(e) }));
        } finally {
            transcribing.current--;
        }
    };

    const conversationEnded = (reason: ConversationEnd) => {
        setLocalVoice((v) => (v === 'listening' ? null : v));
        level.current = null;
        report({ state: 'idle', sessionId });
        if (reason !== 'user' && reason !== 'left') setVoiceNotice(t(`voice.ended.${reason}`));
    };

    const beginConversation = async () => {
        stopSpeaking();
        setVoiceNotice(null);
        setError(null);
        const seconds = voiceConfigRef.current?.settings.silenceEndSeconds ?? DEFAULT_SILENCE_END_SECONDS;
        try {
            await startConversation(seconds * 1000);
            setLocalVoice('listening');
            report({ state: 'listening', sessionId });
        } catch (e) {
            setError(t('voice.micDenied', { msg: errorText(e) }));
        }
    };

    const segmentRef = useRef(handleSegment);
    const endedRef = useRef(conversationEnded);
    useEffect(() => {
        segmentRef.current = handleSegment;
        endedRef.current = conversationEnded;
    });
    useEffect(
        () =>
            attachConversation({
                onLevel: (l) => {
                    if (!playback.current) level.current = l;
                },
                // 打断:只停朗读、丢掉还没播的分段,正在进行的运行不取消
                onSpeechStart: () => {
                    if (playback.current) stopSpeaking();
                    setLocalVoice('listening');
                },
                onSegment: (blob) => void segmentRef.current(blob),
                isPaused: () =>
                    playback.current !== null ||
                    transcribing.current > 0 ||
                    liveRef.current !== null ||
                    spokenQueueRef.current.length > 0,
                onEnded: (reason) => endedRef.current(reason),
            }),
        [],
    );
    useEffect(() => {
        flushRef.current = flushQueue;
    });
    useEffect(() => {
        if (!live && !uploading) flushRef.current();
    }, [live, uploading]);

    const pressRef = useRef(pressVoice);
    const releaseRef = useRef(releaseVoice);
    // 事件监听与 consume 通过 ref 调用最新的函数
    useEffect(() => {
        speakRef.current = speak;
        pressRef.current = pressVoice;
        releaseRef.current = releaseVoice;
    });
    const voiceEnabled = voiceConfig?.stt === true;
    // 默认输入方式是语音、而且真的能录音时才换成语音界面;旧服务器没有 inputMode,按文字处理
    const wantsVoice = voiceConfig?.settings.inputMode === 'voice';
    const voiceFirst = wantsVoice && voiceEnabled;
    const voiceFallback = wantsVoice && !voiceEnabled ? (canRecord() ? 'noStt' : 'noMic') : null;
    const continuous = voiceFirst && voiceConfig?.settings.continuous === true;
    const cancelRef = useRef(cancelRecording);
    const stopRef = useRef(async () => undefined as void);
    useEffect(() => {
        cancelRef.current = cancelRecording;
    });

    // 语音界面的快捷键:Ctrl/Cmd+I 打开 / 收起文字弹窗;Esc 先取消录音,再收起弹窗(草稿保留)
    useEffect(() => {
        if (!voiceFirst) return;
        const onKey = (e: globalThis.KeyboardEvent) => {
            // 输入法正在组字、或别处已经处理过的按键不再处理
            if (e.defaultPrevented || e.isComposing) return;
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'i') {
                e.preventDefault();
                setPopupOpen((open) => !open);
            } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'h') {
                // 完整对话:主界面上没有入口按钮(ADR 0049 第 10 节)
                e.preventDefault();
                setShowHistory((open) => !open);
            } else if (e.key === 'Escape') {
                if (cancelRef.current()) e.preventDefault();
                else if (conversationState().active && !popupOpenRef.current) {
                    e.preventDefault();
                    endConversation('user');
                } else if (popupOpenRef.current) setPopupOpen(false);
                else if (liveRef.current?.runId) {
                    e.preventDefault();
                    void stopRef.current();
                } else setShowHistory(false);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [voiceFirst]);
    useEffect(() => {
        if (popupOpen) textarea.current?.focus();
    }, [popupOpen]);

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

    const minimal = voiceFirst && !showHistory;
    useEffect(() => {
        onActivity?.({ messages, live, profile, profiles, agents, agentId, chooseAgent, minimal });
    }, [messages, live, profile, profiles, agents, agentId, chooseAgent, onActivity, minimal]);

    // 没有依赖数组:submit 用到的输入框状态每轮都变,这里只是把最新的发送函数交给搜索框。
    useEffect(() => {
        if (!askRef) return;
        askRef.current = (text) => submit(text);
        return () => {
            askRef.current = null;
        };
    });

    /** 输入框里的说话按钮(文字模式)。 */
    const talkButton = (big: boolean) => (
        <button
            type="button"
            className={`voice-button${big ? ' voice-big' : ''}${voiceMode === 'hold' || voiceMode === 'tap' ? ' recording' : ''}`}
            title={big ? t('voice.talk') : t('voice.holdHint')}
            aria-pressed={voiceMode === 'hold' || voiceMode === 'tap'}
            data-testid={big ? 'voice-talk' : 'voice-button'}
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
                    : big
                      ? t('voice.talkIdle')
                      : t('voice.hold')}
        </button>
    );

    const indicatorState = localVoice ?? shown.state;
    // 空对话又空闲时,状态行直接写「开始一段新对话吧。」,不再另起一行
    const blank = messages.length === 0 && !live;
    const indicatorLabel = localVoice
        ? t(`voice.state.${localVoice}`)
        : blank && indicatorState === 'idle' && !shown.label
          ? t('chat.empty')
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

    useEffect(() => {
        stopRef.current = stop;
    });

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

    /** 输入框;语音界面里是 Ctrl/Cmd+I 打开的文字弹窗(ADR 0049 第 1.4 节)。 */
    const composerView = (
        <div
            className={voiceFirst ? 'composer-popup' : 'composer-wrap'}
            {...(voiceFirst
                ? { role: 'dialog', 'aria-label': t('voice.textPopup'), 'data-testid': 'composer-popup' }
                : {})}
        >
            {voiceFirst ? (
                <div className="composer-popup-head">
                    <span>{t('voice.textPopup')}</span>
                    <button type="button" className="link small" onClick={() => setPopupOpen(false)}>
                        {t('voice.closePopup')}
                    </button>
                </div>
            ) : null}
            {images.length > 0 || imageNotice || noVision || uploading ? (
                <div className="composer-images" data-testid="composer-images">
                    {images.length > 0 ? (
                        <ul className="image-previews">
                            {images.map((image) => (
                                <li key={image.key}>
                                    <ComposerPreview file={image.file} />
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
                {voiceFallback ? (
                    <p className="small muted voice-fallback" role="status" data-testid="voice-fallback">
                        {t(voiceFallback === 'noStt' ? 'voice.noStt' : 'voice.noMic')}{' '}
                        {voiceFallback === 'noStt' ? (
                            <a
                                href={routePath({ name: 'settings' })}
                                onClick={(e) => {
                                    e.preventDefault();
                                    navigate({ name: 'settings' });
                                }}
                            >
                                {t('voice.noSttLink')}
                            </a>
                        ) : null}
                    </p>
                ) : null}
                <textarea
                    ref={textarea}
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
                {voiceEnabled && !voiceFirst ? talkButton(false) : null}
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

    /**
     * 极简主界面(ADR 0049 第 10 节):中间只有球,球下三行——状态、音量条与模型名、当前这一句字幕。
     * 球本身就是说话的地方:点按 / 按住说话;连续对话时点一下开始或结束;回复进行中点一下停止。
     * 文字输入用 Ctrl/Cmd+I,完整对话用 Ctrl/Cmd+H,都不放按钮。
     */
    if (minimal) {
        const name = agents.find((a) => a.id === agentId)?.name ?? t('voice.stage.defaultName');
        const recordingNow = voiceMode === 'hold' || voiceMode === 'tap';
        const phase: 'idle' | 'listening' | 'heard' | 'thinking' | 'speaking' =
            recordingNow || (conversation.active && conversation.speech)
                ? conversation.active
                    ? 'heard'
                    : 'listening'
                : voiceMode === 'transcribing'
                  ? 'thinking'
                  : localVoice === 'speaking' || shown.state === 'speaking'
                    ? 'speaking'
                    : live || shown.state === 'thinking' || shown.state === 'executing'
                      ? 'thinking'
                      : conversation.active || localVoice === 'listening' || shown.state === 'listening'
                        ? 'listening'
                        : 'idle';
        const lastOf = (role: Message['role']) => [...messages].reverse().find((m) => m.role === role);
        const reply = live ? live.text : lastOf('assistant') ? textOf(lastOf('assistant')!) : '';
        const userLine = live?.userText ?? '';
        const sentence = currentSentence(markdownToSpeech(reply, t('voice.codeOmitted'))) || currentSentence(userLine);
        const orbState: AssistantState =
            phase === 'heard'
                ? 'listening'
                : phase === 'idle'
                  ? indicatorState
                  : phase === 'thinking'
                    ? 'thinking'
                    : phase;
        const action = continuous
            ? conversation.active
                ? t('voice.endConversation')
                : t('voice.startConversation')
            : live && !recordingNow
              ? t('chat.stop')
              : recordingNow
                ? t('voice.tapRecording')
                : t('voice.talk');
        const orbMode = continuous ? 'conversation' : live && !recordingNow ? 'stop' : 'talk';
        return (
            <div
                className={workbench ? 'chat chat-stage voice-min' : 'chat voice-min'}
                data-voice-first=""
                data-phase={phase}
            >
                {conversation.active ? (
                    <div className="mic-on" role="status" data-testid="mic-on">
                        <span className="mic-on-dot" aria-hidden="true" />
                        <span>{t('voice.micOn')}</span>
                    </div>
                ) : null}
                <div className="voice-min-stage" data-testid="voice-stage">
                    <button
                        type="button"
                        className="voice-min-orb"
                        aria-label={action}
                        data-testid={`voice-${orbMode}`}
                        aria-pressed={orbMode === 'conversation' ? conversation.active : recordingNow}
                        disabled={orbMode === 'stop' ? !live?.runId : voiceMode === 'transcribing'}
                        onClick={() => {
                            if (orbMode === 'conversation') {
                                if (conversation.active) endConversation('user');
                                else void beginConversation();
                            } else if (orbMode === 'stop') void stop();
                        }}
                        onPointerDown={(e) => {
                            if (orbMode !== 'talk') return;
                            e.preventDefault();
                            pressVoice();
                        }}
                        onPointerUp={() => {
                            if (orbMode === 'talk') releaseVoice();
                        }}
                        onPointerLeave={() => {
                            if (orbMode === 'talk' && mode.current === 'hold') void finishRecording();
                        }}
                        onKeyDown={(e) => {
                            if (orbMode !== 'talk') return;
                            if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
                                e.preventDefault();
                                pressVoice();
                            }
                        }}
                        onKeyUp={(e) => {
                            if (orbMode !== 'talk') return;
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                pressedAt.current = 0;
                                releaseVoice();
                            }
                        }}
                    >
                        <VoiceIndicator state={orbState} level={level} />
                    </button>
                    <p className="voice-min-status" aria-live="polite" data-testid="voice-status">
                        {phase === 'idle' ? name : t(`voice.stage.${phase}`, { name })}
                    </p>
                    <p className="voice-min-meta">
                        <LevelBar level={level} />
                        <span>{profile?.label ?? t('wb.noModel')}</span>
                    </p>
                    <p className="voice-min-caption" data-testid="voice-caption">
                        {sentence}
                    </p>
                    {live?.tools
                        .filter((tool) => tool.approval && !tool.approval.decision)
                        .map((tool) => (
                            <ToolCard key={tool.callId} tool={tool} live />
                        ))}
                    {error ? <p className="error">{t('chat.failed', { msg: error })}</p> : null}
                    {voiceNotice ? (
                        <p className="small warning" role="status">
                            {voiceNotice}
                        </p>
                    ) : null}
                </div>
                {popupOpen ? composerView : null}
            </div>
        );
    }

    return (
        <div
            className={workbench ? 'chat chat-stage' : 'chat'}
            data-blank={blank ? '' : undefined}
            data-voice-first={voiceFirst ? '' : undefined}
        >
            {conversation.active ? (
                <div className="mic-on" role="status" data-testid="mic-on">
                    <span className="mic-on-dot" aria-hidden="true" />
                    <span>{t('voice.micOn')}</span>
                    <button type="button" className="link small" onClick={() => endConversation('user')}>
                        {t('voice.endConversation')}
                    </button>
                </div>
            ) : null}
            <div className="chat-head">
                <VoiceIndicator state={indicatorState} label={indicatorLabel} level={level} />
                {agents.length > 0 ? (
                    <label className="agent-picker small">
                        {t('agents.picker')}{' '}
                        <select
                            value={agentId}
                            onChange={(e) => chooseAgent(e.target.value)}
                            data-testid="agent-picker"
                        >
                            <option value="">{t('agents.pickerNone')}</option>
                            {agents.map((a) => (
                                <option key={a.id} value={a.id}>
                                    {a.name}
                                </option>
                            ))}
                        </select>
                    </label>
                ) : null}
                {sessionId ? (
                    <button type="button" className="link small" onClick={() => void deleteSession()}>
                        {t('chat.delete')}
                    </button>
                ) : null}
            </div>
            {
                <div className="messages" data-testid="messages">
                    {blank && indicatorState !== 'idle' ? <p className="muted empty">{t('chat.empty')}</p> : null}
                    {messages.map((m) => (
                        <div key={m.id} className={`message ${m.role}`} data-status={m.status} data-message-id={m.id}>
                            {m.role === 'assistant' ? <Avatar /> : null}
                            {m.role === 'user' ? (
                                <p className="user-text">{textOf(m)}</p>
                            ) : (
                                <Markdown text={textOf(m)} />
                            )}
                            {m.role === 'user' ? <MessageImages message={m} /> : null}
                            {toolsOf(m, results).map((tool) => (
                                <ToolCard key={tool.callId} tool={tool} />
                            ))}
                            {m.runId && m.parts.some((p) => p.type === 'tool-call' && p.name === 'delegate') ? (
                                <DelegationTree runId={m.runId} active={false} />
                            ) : null}
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
                            <Avatar />
                            {live.text ? <Markdown text={live.text} /> : null}
                            {live.tools.map((tool) => (
                                <ToolCard key={tool.callId} tool={tool} live />
                            ))}
                            {live.runId && live.tools.some((tool) => tool.name === 'delegate') ? (
                                <DelegationTree runId={live.runId} active />
                            ) : null}
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
            }
            {voiceFirst ? (
                <div className="voice-controls">
                    <button
                        type="button"
                        className="link small"
                        aria-expanded={showHistory}
                        onClick={() => setShowHistory(false)}
                        data-testid="voice-history"
                    >
                        {t('voice.hideHistory')}
                    </button>
                </div>
            ) : null}
            {!voiceFirst || popupOpen ? composerView : null}
        </div>
    );
}
