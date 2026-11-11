# ADR 0021 · 语音:服务器转发的 STT / TTS、语音状态的来源

- 状态:提议(M4 PR 2,先于实现;接口在 M4 PR 4 `feat/voice-api`,Web 与状态在 M4 PR 5 `feat/voice-web`)
- 日期:2026-11-11
- 相关:开发计划第 4.1 节(语音状态指示器)、第 6.1 节(`assistant-state`)、第 8 节 M4、第 12 节(资源预算);`docs/milestones/M4-plan.md`;ADR 0004(API v1 约定)、ADR 0006(模型网关)、ADR 0010(工具与审批、审计)、ADR 0018(内存预算)、ADR 0020(附件的魔数检查与错误码)

## 背景

M4 要让用户在浏览器里说话、听回复。计划要求「前端不自行推断状态」,而麦克风与扬声器都在浏览器里;端点的密钥只在服务器上(ADR 0006)。另外,M5a 的 IM 渠道也要用语音转写,接口需要不依赖 Web。本 ADR 定下:谁调用语音端点、接口长什么样、音频怎么处理、`listening` / `speaking` 由谁发出、状态文字从哪里来。

## 1. 决定

1. **服务器转发**:浏览器把录音发给 FatCat-AI,服务器用配置档里的密钥调用用户配置的端点;浏览器只拿到转写文本或音频流,密钥不出服务器。
2. **只支持 OpenAI 兼容的语音接口**(`/audio/transcriptions`、`/audio/speech`):这是大多数服务(包括国内兼容服务与自托管的 whisper / TTS 服务)共同的格式。Anthropic 没有语音接口;Gemini 的语音走多模态生成,不在 M4。语音配置档必须是 `openai-compatible`,否则设置时报 `validation_failed`。
3. **不引入 SDK、不加常驻依赖**:与 ADR 0006 一样用 `fetch` 与 `FormData`;本地语音组件(sherpa-onnx / whisper.cpp)推迟(M4 方案问题 2)。
4. **音频不落盘、不进日志、不进审计正文**。转写出来的文字作为用户消息正常保存(那是用户的输入);朗读用的音频只经过服务器,不保存。

## 2. 配置

- 使用 `purpose` 含 `stt` / `tts` 的配置档(`ModelPurpose` 里已有这两个值)。
- 设置增加 `voice` 一组(PR 4 起提供):

  ```ts
  voice: {
      /** 为 null 时取第一个 purpose 含 stt 的配置档;都没有时语音输入不可用。 */
      defaultSttProfileId: Id | null,
      defaultTtsProfileId: Id | null,
      /** 按住说话松开后自动发送;false 时只填进输入框(M4 方案问题 5)。 */
      autoSend: boolean,   // 默认 true
      /** 回复结束后自动朗读。 */
      autoSpeak: boolean,  // 默认 false
  }
  ```

- TTS 的音色写在配置档的 `params.voice`(`ModelParams` 增加的可选字段,1–64 个字符,PR 4 起提供);省略时由服务器发 `alloy`(OpenAI 的默认音色名;其他服务的音色名不同,用户需要自己填)。真机端点确定后(M4 方案问题 1)再核对。
- 设置页的配置档列表里,`stt` / `tts` 配置档的「测试连接」仍调用 `GET /models`(ADR 0006),不实际转写或合成。

## 3. 转写:`POST /api/v1/voice/transcriptions`

- 请求:`multipart/form-data`。
  - `file`:录音,必填。
  - `language`:可选,ISO 639-1(`zh`、`en`…),省略时按界面语言;服务器原样传给端点。
  - `profileId`:可选,覆盖默认 STT 配置档。
- 服务器发给端点:`POST {baseURL}/audio/transcriptions`,字段 `file`、`model`、`response_format=json`、`language`(有时)。
- 响应 `200`:`{ text, profileId }`。文本去掉首尾空白;为空时照样返回空字符串,由客户端提示「没有听清」。
- **类型按魔数判断**(与 ADR 0020 第 2 节同样的原则),不信任 `Content-Type` 与文件名;发给端点时用判断出的类型与对应扩展名(`audio.webm` 等):

  | 类型         | 魔数                                             | 常见来源                |
  | ------------ | ------------------------------------------------ | ----------------------- |
  | `audio/webm` | `1A 45 DF A3`(EBML)                              | Chrome / Edge / Firefox |
  | `audio/ogg`  | `4F 67 67 53`(`OggS`)                            | Firefox                 |
  | `audio/mp4`  | `ftyp`(第 4–7 字节),且 major brand 在白名单中¹   | Safari                  |
  | `audio/wav`  | `52 49 46 46 ?? ?? ?? ?? 57 41 56 45`(RIFF…WAVE) | 测试与 IM 渠道          |
  | `audio/mpeg` | `49 44 33`(`ID3`)或 `FF Ex` / `FF Fx` 帧同步     | IM 渠道                 |

  ¹ `ftyp` 也出现在 HEIC 图片与 MP4 / QuickTime 视频中,只看 `ftyp` 会把它们当成录音。白名单:`M4A `、`M4B `、`mp41`、`mp42`、`isom`、`iso2`、`iso5`、`iso6`、`dash`、`3gp4`、`3gp5`(浏览器录音与常见音频);其余(如 `heic`、`qt  `)返回 null。M4 PR 3 起生效。

- 上限:≤ 10 MiB(`MAX_TRANSCRIPTION_BYTES`,超过 `413`);类型不对 `415`。录音时长 ≤ 120 秒(`MAX_RECORDING_SECONDS`)由客户端在录音时卡住;**M4 的服务器只检查字节数,不解析容器时长**(不为此引入解析库)。10 MiB 对 120 秒的 Opus / AAC 绰绰有余,对 16 kHz 单声道 WAV 约 5 分钟,所以服务器侧仍有一个大致的上界。
- 请求体按读到的字节数流式检查,超过上限立即中止,不先读完再判断;整个音频在内存中最多保留一份(`FormData` 转发需要),请求结束即释放。

## 4. 朗读:`POST /api/v1/voice/speech`

- 请求:JSON `{ text, profileId?, format? }`,`text` 1–4,000 个字符(`MAX_SPEECH_CHARS`),`format` 为 `mp3`(默认)/ `opus` / `wav`。未知字段拒绝。
- 服务器发给端点:`POST {baseURL}/audio/speech`,`{ model, input: text, voice, response_format: format }`。
- 响应 `200`:把上游的音频流**逐块转发**,`Content-Type` 按 `format`(`audio/mpeg` / `audio/ogg` / `audio/wav`),`Cache-Control: no-store`;不在内存里攒整段音频,客户端断开时中止上游请求。
- 文字由客户端准备:Web 把回复的 Markdown 转成纯文本(代码块换成「(代码已省略)」/ "(code omitted)",链接只读文字),超过 4,000 字时按句子边界切成几段依次请求。服务器不解析 Markdown。

## 5. 公共规则(两个接口相同)

- 都需要登录与 CSRF(与其他写接口相同),按 `ownerId` 取配置档;用别人的或不存在的 `profileId` 返回 `404`。
- 没有可用的语音配置档:`400 model_profile_missing`;配置档没有密钥:`400 model_key_missing`(都是已有错误码)。
- 上游错误按 ADR 0006 归类,返回 `502 provider_error` 与 `providerCode`;错误信息脱敏。
- 限流:每个用户每分钟转写与朗读各 20 次,超过 `429 rate_limited`(带 `Retry-After`)。内存里计数,重启清零。
- 超时:转写整体 60 秒;朗读首字节 15 秒,之后两块之间超过 30 秒中止。都归为 `providerCode: 'timeout'`。
- 审计(ADR 0010 第 6 节):动作 `voice.transcribe` / `voice.speak`,只记配置档 id、字节数、字符数、耗时、状态码;**不记音频、不记转写文字、不记朗读文字**。
- 日志同样不写音频与文字;请求体日志对这两个路径关闭。
- 新错误码沿用 ADR 0020 的 `payload_too_large` 与 `unsupported_media_type`。

## 6. 语音状态:`listening` 与 `speaking` 由浏览器上报

服务器看不到麦克风与播放,所以由浏览器上报、服务器广播(M4 方案问题 4):

- WebSocket 客户端帧增加 `voice-state`(PR 5 起提供;旧服务器会对它回 `error` 帧,客户端忽略即可):

  ```ts
  frame(
    'voice-state',
    z.object({
      state: z.enum(['listening', 'speaking', 'idle']),
      /** 正在对哪个会话说话 / 朗读哪个会话的回复。 */
      sessionId: Id.nullable(),
    }),
  );
  ```

- 服务器收到后发一个 `assistant-state` 事件(信封的 `sessionId` 为上报的值),和其他事件一样写入事件表、推给本人所有在线的端;`thinking` / `executing` 仍由 runner 发。
- **电平 `level` 不上报**:随音量脉动只在本地有意义,每秒几十次的电平不应该经过服务器。本地录音 / 播放的那个端自己用电平驱动指示器;其他端收到的 `assistant-state` 没有 `level`,指示器用默认的呼吸动画。
- 状态以最后一个事件为准,不做优先级合并。上报 `listening` 或 `speaking` 的连接断开时,服务器替它发一次 `idle`,避免其他端一直停在「正在听」。
- 客户端补发(`lastSeq`)收到的旧 `assistant-state` 只用于恢复「最后一个状态」;如果它早于 30 秒前,按 `idle` 显示。
- 同一用户每秒最多接受 5 个 `voice-state` 帧,多余的丢弃(不报错)。

## 7. 状态文字:`label` 与 `activityLabel`

- runner 发 `assistant-state` 时带 `label`:`thinking` →「正在思考…」/ "Thinking…";`executing` → 工具的 `activityLabel`,没有时用「正在使用 <工具名>…」/ "Using <tool>…"。浏览器上报的状态由服务器补上 `label`(「正在听…」「正在朗读…」)。
- `label` 按设置里的界面语言(`Settings.locale`)生成,文字表放在服务器端;客户端直接显示 `label`,没有 `label` 时(旧服务器)按 `state` 用自己的默认文字。
- 内置工具可以声明 `activityLabel`(中英文各一句,例如 `mail.send` →「正在发送邮件…」);MCP 工具没有,使用默认文字。`ToolInfo` 增加可选的 `activityLabel`(PR 5 起提供),方便设置页显示。
- 状态变化在客户端去抖 ≥ 150 ms 再改文字,避免 `thinking` / `executing` 快速交替时闪烁;`aria-live="polite"`。

## 8. 契约(`packages/shared`,本 PR 加入)

本 PR 只加入**新的、独立的** schema 与常量(`voice.ts`),不改 `Settings`、`ModelParams`、`ClientFrame`、`ToolInfo` 与 `ErrorCode`,因此 OpenAPI 文档与 WebSocket 协议不变。接入这些现有 schema 的改动和实现一起提交:设置、`params.voice` 与接口在 PR 4,`voice-state` 帧、`label` 与 `activityLabel` 在 PR 5。

```ts
export const AUDIO_MEDIA_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg'] as const;
export const AudioMediaType = z.enum(AUDIO_MEDIA_TYPES);
export const MAX_TRANSCRIPTION_BYTES = 10 * 1024 * 1024;
export const MAX_RECORDING_SECONDS = 120;
export const MAX_SPEECH_CHARS = 4000;

export const TranscriptionResult = z.object({ text: z.string(), profileId: Id });
export const SpeechFormat = z.enum(['mp3', 'opus', 'wav']);
export const SpeechRequest = z.strictObject({
  text: z.string().trim().min(1).max(MAX_SPEECH_CHARS),
  profileId: Id.optional(),
  format: SpeechFormat.optional(),
});
export const VoiceSettings = z.object({ defaultSttProfileId, defaultTtsProfileId, autoSend, autoSpeak });
export const VoiceStateReport = z.object({
  state: z.enum(['listening', 'speaking', 'idle']),
  sessionId: Id.nullable(),
});

export function sniffAudioType(bytes: Uint8Array): AudioMediaType | null;
```

## 后果

- 每次语音往返多经过一次服务器,额外开销由 M4 PR 6 在 CI 中用假端点测量(验收线 < 1 秒)。
- 只支持 OpenAI 兼容的语音接口;使用其他格式的服务需要一个兼容层或以后的适配器。
- 服务器不检查录音时长,只检查字节数;如果以后 IM 渠道需要精确的时长上限,再考虑解析容器头。
- 多端看到的语音状态一致,代价是每次开始 / 结束录音或朗读多一个事件写入事件表。
