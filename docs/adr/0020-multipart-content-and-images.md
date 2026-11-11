# ADR 0020 · 多段内容与图片附件:模型网关契约、上传、存储

- 状态:提议(M4 PR 2,先于实现;实现在 M4 PR 3 `feat/image-input`)
- 日期:2026-11-11
- 相关:开发计划第 8 节 M4;`docs/milestones/M4-plan.md`;ADR 0004(API v1 约定)、ADR 0005(存储)、ADR 0006(模型网关)、ADR 0010 第 7 节(不可信内容)、ADR 0018(内存预算)
- 修订:ADR 0006 的 `ChatMessage.content` 从只能是字符串改为「字符串或多段内容」(第 1 节)

## 背景

M2 推迟了图片输入(M2 方案问题 10),原因是模型网关的 `ChatMessage.content` 只能是字符串,三种适配器都按字符串拼请求。M4 要让用户在 Web 聊天里把图片交给支持图片的模型,需要先定下四件事:网关内部怎么表示图片、配置档怎么声明能力、HTTP API 怎么上传与引用图片、图片存在哪里以及何时删除。

## 1. 网关内部的多段内容(`packages/providers`)

```ts
export type ContentPart =
  | { type: 'text'; text: string }
  /** data 为 base64(不含 `data:` 前缀),只在网关内部使用,不出现在 HTTP API 中。 */
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string };

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };
```

- 只有 `user` 消息可以带图片;system、assistant、tool 仍然只是字符串(工具返回的图片不在 M4 范围,见第 7 节)。
- 字符串仍然合法,现有调用方不用改。适配器先用一个公共函数把 `string` 规范成 `[{ type: 'text', text }]` 再映射,避免三处各写一遍。
- `ContentPart` 是网关的内部类型,**不放进 `packages/shared`**:base64 图片不应出现在 API 契约里,API 只用附件 id 引用图片(第 4 节)。这一点与 M4 方案第 2 节「shared 中的 `ContentPart`」不同,以本 ADR 为准。

### 1.1 适配器映射

| 适配器      | 文本段                   | 图片段                                                                        |
| ----------- | ------------------------ | ----------------------------------------------------------------------------- |
| OpenAI 兼容 | `{ type: 'text', text }` | `{ type: 'image_url', image_url: { url: 'data:<mediaType>;base64,<data>' } }` |
| Anthropic   | `{ type: 'text', text }` | `{ type: 'image', source: { type: 'base64', media_type, data } }`             |
| Gemini      | `{ text }`               | `{ inlineData: { mimeType, data } }`                                          |

- 只有文本段的 user 消息照旧发字符串(OpenAI 兼容、Anthropic),请求体与 M3 完全相同,已有的录制回放测试不受影响。
- Anthropic 合并相邻同角色消息时(ADR 0006 第 5 节),多段内容按顺序拼接。

### 1.2 能力声明与 `model_no_vision`

- 配置档增加可选字段 `vision: boolean`,省略即 `false`,由用户自己勾选。OpenAI 兼容端点没有可靠的能力查询接口,按模型名猜测会过时,所以不猜。
- 发送带图片的消息时,如果所用配置档没有 `vision: true`,服务器在调用模型之前返回 `400`,错误码 `model_no_vision`;**不悄悄丢掉图片**,也不先发给模型再看它是否报错。
- 历史消息里有图片、但用户把会话切换到不支持图片的配置档时,不报错:这时送给模型的历史图片一律换成占位文本 `[图片:<文件名>]`(与第 6 节相同),只有本轮新发送的图片会触发 `model_no_vision`。
- 上游仍可能拒绝某张图片(尺寸、格式、内容审核),按 ADR 0006 归为 `bad_request` 等已有的 `providerCode`,不新增分类。

## 2. 可接受的图片

- 类型:PNG、JPEG、WebP、GIF(GIF 只取第一帧由上游决定,我们不处理)。
- **按魔数判断类型**,不信任文件名、扩展名与请求里的 `Content-Type`。判断函数 `sniffImageType()` 放在 `packages/shared`(纯函数,Web 在选文件时也可以先查一遍,服务器再查一遍):

  | 类型 | 魔数                                             |
  | ---- | ------------------------------------------------ |
  | PNG  | `89 50 4E 47 0D 0A 1A 0A`                        |
  | JPEG | `FF D8 FF`                                       |
  | GIF  | `47 49 46 38 37 61` 或 `47 49 46 38 39 61`       |
  | WebP | `52 49 46 46 ?? ?? ?? ?? 57 45 42 50`(RIFF…WEBP) |

- 单张 ≤ 5 MiB(`MAX_ATTACHMENT_BYTES`),每条消息 ≤ 4 张(`MAX_ATTACHMENTS_PER_MESSAGE`)。超过大小返回 `413`,类型不对返回 `415`。
- 不解码、不缩放、不去 EXIF:服务器不引入图像库(ADR 0018,新增依赖先测内存)。缩放与去 EXIF 由 Web 在上传前用 Canvas 做,见第 5 节。
- 文件名只作显示:去掉路径部分与控制字符,截到 255 个字符;为空时用 `image.<扩展名>`。

## 3. 存储(`packages/storage`)

- 文件存在数据目录的 `attachments/` 下,文件名是随机 id(与附件 id 相同),没有扩展名;**不使用用户给的文件名**。
- 新表 `message_attachments`(迁移在 PR 3):

  | 列           | 说明                                                      |
  | ------------ | --------------------------------------------------------- |
  | `id`         | 主键,随机 id                                              |
  | `owner_id`   | 所有者(1.0 单用户,照样按它取数据)                         |
  | `message_id` | 所属消息,外键 `ON DELETE CASCADE`;上传后未发送时为 `NULL` |
  | `media_type` | 按魔数判断出的类型                                        |
  | `bytes`      | 字节数                                                    |
  | `sha256`     | 十六进制摘要,用于完整性检查与以后的去重                   |
  | `file_name`  | 显示用文件名                                              |
  | `created_at` | 上传时间                                                  |

- 删除会话或消息时,数据库行随外键删除;对应文件由同一事务提交后的清理步骤删除(文件删除失败只写警告日志,下一次维护任务再删)。
- 上传后 24 小时内没有被任何消息引用的附件,由每天的维护任务(ADR 0007 的 03:30 任务)删除。
- 备份(ADR 0005)包含 `attachments/` 目录。
- 图片内容不进日志、不进审计正文;审计只记 `media_type`、`bytes`、`sha256` 前 12 位。

## 4. HTTP API(`/api/v1`,在 PR 3 加入)

- `POST /api/v1/attachments`:`multipart/form-data`,一个 `file` 字段。成功返回 `201` 与 `Attachment`(见第 8 节),`messageId` 为 `null`。需要登录与 CSRF(与其他写接口相同)。
- `GET /api/v1/attachments/{id}`:返回原始字节,`Content-Type` 为存储的 `media_type`,另加 `X-Content-Type-Options: nosniff`、`Content-Disposition: inline`、`Cache-Control: private, max-age=31536000, immutable`。只给 `owner_id` 本人,其他人一律 `404`(不暴露是否存在)。
- `SendMessageRequest` 增加可选的 `attachmentIds`(1–4 个,不能重复)。服务器检查每个 id 属于本人、尚未被其他消息引用;不满足时整条请求 `400 validation_failed`,不创建消息。`text` 仍然必填:只发图片时 Web 会填一个默认提示,见第 5 节。
- `Message.parts` 增加 `{ type: 'image', attachmentId, mediaType, fileName }`。客户端须忽略不认识的 part 类型(ADR 0004),旧客户端只是看不到图片。
- 新错误码:`model_no_vision`(400)、`payload_too_large`(413)、`unsupported_media_type`(415)。都是 `ErrorCode` 的增量。
- 单个上传请求体在读完之前就按 `Content-Length` 与已读字节数卡在 5 MiB + 表单开销;不先把整个请求读进内存再判断。

## 5. Web

- 输入框旁的「图片」按钮、拖放与粘贴;发送前显示缩略图,可逐张移除。
- 上传前在浏览器里用 Canvas 把长边缩到 2048 px 以内并重新编码(JPEG 质量 0.9,PNG 保持 PNG),顺带去掉 EXIF(含 GPS)。GIF 原样上传。
- 当前配置档没勾「支持图片」时,按钮旁提示原因并禁用发送;服务器的 `model_no_vision` 是最后一道检查。
- 只发图片、不写文字时,`text` 填「请看这张图片。」/「Please look at this image.」(按界面语言)。

## 6. 上下文与 token

- 送给模型的上下文里,最多保留最近 8 张图片的原图;更早的图片换成 `[图片:<文件名>]`。每轮都把全部历史图片重新发一遍会让请求越来越大。
- 估算上下文预算时,每张图片按固定 1,600 token 计算(常见模型对 1–2 MP 图片的计费量级);不按像素精确计算,因为各家算法不同。
- 上下文压缩(cheap 模型写摘要)时,被压缩段里的图片同样换成占位文本,不把图片发给 cheap 模型。
- 记忆自动抽取只看文本,不看图片。

## 7. 不在本 ADR 范围

- 工具返回的图片(网页截图、邮件图片附件)与 `fs.read` 读图片文件:这些是外部内容,需要先定义「不可信图片」的规则(ADR 0010 第 7 节只覆盖文本),以后单独写 ADR。
- 用户自己上传的图片**不标记为不可信**:它和用户输入的文字同一来源。
- 音频交给多模态模型、视频、PDF 附件:不在 1.0 范围。

## 8. 契约(`packages/shared`,本 PR 加入)

本 PR 只加入**新的、独立的** schema 与常量(`attachments.ts`),不改现有 schema,因此 OpenAPI 文档不变。把它们接进 `ModelProfile`、`SendMessageRequest`、`Message.parts` 与 `ErrorCode` 的改动和接口实现一起在 PR 3 提交,避免出现「契约里有字段、服务器却悄悄忽略」的中间状态。

```ts
export const ATTACHMENT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const AttachmentMediaType = z.enum(ATTACHMENT_MEDIA_TYPES);
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

/** POST /api/v1/attachments 的响应。 */
export const Attachment = z.object({
  id: Id,
  messageId: Id.nullable(),
  mediaType: AttachmentMediaType,
  bytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fileName: z.string().min(1).max(255),
  createdAt: IsoDateTime,
});

/** PR 3 起加入 MessagePart。 */
export const ImageMessagePart = z.object({
  type: z.literal('image'),
  attachmentId: Id,
  mediaType: AttachmentMediaType,
  fileName: z.string().min(1).max(255),
});

/** PR 3 起作为 SendMessageRequest.attachmentIds。 */
export const AttachmentIds = z.array(Id).min(1).max(MAX_ATTACHMENTS_PER_MESSAGE); // 另检查不重复

export function sniffImageType(bytes: Uint8Array): AttachmentMediaType | null;
export function sanitizeFileName(name: string, mediaType: AttachmentMediaType): string;
```

## 后果

- 三种适配器各多一段映射,请求体只在有图片时变化;没有新的运行时依赖,空闲内存不变。
- 数据目录多一个 `attachments/` 目录,备份变大;删除会话会一并删除图片文件。
- 用户需要自己勾选「支持图片」;勾错时会在第一次发图时看到上游的 `bad_request`。
- 以后支持工具返回的图片时,`ContentPart` 可以加一个来源标记,不影响本 ADR 的 API。
