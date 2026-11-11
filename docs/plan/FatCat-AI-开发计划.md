# FatCat-AI 开发计划 v7(交给 Claude Code 执行)

> 改名说明:项目已于 2026-11-10 由 AI-Personal 改名为 FatCat-AI,仓库迁到 <https://github.com/CodingLossy/FatCat-AI>(见 `docs/adr/0019-rename-fatcat-ai.md`);本文已按新名称更新。
> 版本:v7 · 2026-11-10(M5 拆为 M5a/M5b/M5c、内存预算改为防退化、补 M3.x 清理,见第 18 节;v6 · 2026-11-03 并入《记忆模块补充设计》与 M1 实施决定,见 ADR 0004–0007)· 许可证:**AGPL-3.0-only + 商业许可(双许可 / dual licensing)**,详见第 15 节;业主已定决策汇总见第 16 节
> 作者 / 版权持有人:**尹绪柏 (Theodore Yin)** · 仓库名:**FatCat-AI** · 商业许可联系:x19169738916@163.com
> 范围:**框架优先**——先做无界面(headless)核心服务 + 稳定的 HTTP/WebSocket API + Web UI + IM 渠道;桌面应用与 iOS/Android 客户端属于后续阶段,但核心从第一天起就按「客户端可随时接入」来设计。
> 本文件即开发总纲。请 Claude Code 先通读全文(首条启动提示词见第 17 节),再从「第 8 节 M0」开始逐个里程碑实施;每个里程碑结束时跑通验收清单再进入下一个。不确定的地方遵循第 13 节「给 Claude Code 的工作约定」。

---

## 0. 一页纸摘要

- **是什么**:一个可自托管的**开源**(AGPL-3.0,OSI 认证开源许可)个人 AI 助手框架;需要闭源/商业使用的组织可向作者购买商业许可。能读写本地文件、收发邮件、语音对话、定时任务,并能从网页/桌面/手机/企业微信/微信等渠道远程使用(QQ 在 1.0 之后接入)。所有内容(邮件、小说、人物、视频数据……)汇入统一条目索引,可通过**「知识地图」**逐层钻取浏览(1.0 为列表/树形分类浏览器,桌面版 M10 升级为粒子球钻取导航)。
- **核心原则**:自带模型(BYO LLM:用户填 API Base URL + Key,兼容 OpenAI 协议即可)、本地优先、**零遥测**、权限显式授予、插件化(MCP 为一等公民)。
- **推荐技术栈(结论)**:**TypeScript 单仓(pnpm monorepo)**——Node.js 核心服务 + React Web UI + **Tauri v2 桌面壳(Node 核心以 sidecar 方式运行)**。服务器端同一个核心直接用 Docker 跑,2GB 内存机器空闲上限 250 MiB(不配置渠道时,见第 12 节)。理由与取舍见第 3 节。
- **路线**:
  - **阶段一 · 框架(headless 核心)**:M0 脚手架 → M1 对话核心 + BYO LLM + API v1 → M2 工具与本地文件 → M3 邮件 → M3.x 清理 → M4 语音 → M5a 渠道(企业微信 + 微信)→ M5b 知识地图浏览器与安全加固 → M5c 部署与发布(发布 v1.0,单用户)→ M6 定时任务/自动化 → M7 插件系统与市场 → M8 多智能体 → M9 i18n 与文档站。
  - **阶段二 · 客户端**:M10 桌面应用(Tauri,含知识地图粒子球导航)→ M11 移动端(PWA → iOS/Android)。
  - **阶段三**:M12 稳定化与 2.0(多用户、QQ 及更多渠道)。
- **许可**:AGPL-3.0-only(社区版)+ 作者尹绪柏 (Theodore Yin) 单独授予的商业许可;贡献者签 CLA,保证作者能把贡献一并纳入商业许可;插件 SDK 与客户端 SDK 为 Apache-2.0(见第 15 节)。

---

## 1. 愿景与定位

### 1.1 愿景
「一个真正属于你自己的 AI 助手」:数据在你自己的电脑或服务器上,模型由你选、钥匙在你手里,能力靠插件无限扩展,在你常用的任何地方(桌面、浏览器、手机、企业微信、微信,以后还有 QQ 等)都能找到它;你的全部资料组成一张可逐层钻取的「知识地图」。

### 1.2 目标用户
1. **个人开发者/极客**:有自己的 VPS(如 2C2G),想要一个 24 小时在线、能推送提醒的助手。
2. **知识工作者**:想要一个装上就能用的桌面应用,处理本地文档、邮件、会议录音。
3. **小团队**(2.0 起):在企业微信里共享一个助手,各自的数据隔离(多用户在 2.0 实现,1.0 只支持单用户)。

### 1.3 非目标(至少 1.0 之前不做)
- 不做模型训练/微调;不自带托管模型服务(但支持对接本地 Ollama / LM Studio / vLLM 等 OpenAI 兼容端点)。
- 不做 SaaS 多租户云服务;不做账号体系之外的计费。
- 不收集任何遥测数据(见第 10 节)。
- **不做多用户**:1.0 只有一个主人账户(多设备、多渠道均绑定同一主人);多用户/家庭/团队账户放到 2.0(M12)。

### 1.4 设计原则
1. **本地优先**:默认单机可用,所有数据存在用户数据目录的 SQLite + 文件里。
2. **BYO LLM**:任何 OpenAI 兼容端点;另提供 Anthropic / Gemini 原生适配。支持多个「模型配置档」,按用途路由(对话/便宜的摘要/嵌入/语音)。
3. **最小权限**:每个工具声明权限(文件路径白名单、网络、发邮件、执行命令),危险操作默认需要人工确认。
4. **Headless 核心,多种外壳**:core 是一个不依赖任何 UI 的服务进程,只通过版本化的 HTTP + WebSocket API(见 6.1)对外;Web UI、CLI、IM 渠道是第一批客户端,桌面壳与 iOS/Android 客户端以后用**同一套公开 API** 接入,核心无需改动。
5. **可观测但不外传**:本地日志、本地 trace 查看器;永不上报。
6. **可测试、可评估**:每个能力都有单测 + 录制回放的 LLM 测试 + 评测集。

---

## 2. 功能全景

| 领域 | 1.0(M1–M5)| 1.x / 2.0(M6–M12,桌面与移动在阶段二)|
|---|---|---|
| 对话 | 流式对话、多会话、Markdown/代码渲染、附件、上下文压缩 | 分支对话、会话搜索、导出 |
| 模型 | BYO OpenAI 兼容端点、多配置档、Anthropic/Gemini 原生 | 按任务自动路由、成本统计(本地)、本地模型一键检测 |
| 记忆 | M1:记忆 v1(`memory.save / memory.search`,FTS 检索,写入需审批);M2:记忆 v2——有类型(经历/事实/方法/决策)、单值事实可更替且保留历史、每条带出处、FTS+向量+图三路召回、可信度说明、会话开头 digest、衰减与分层、用户反馈、凭据拒存与写入时脱敏(见《记忆模块补充设计》、ADR 0007)| 记忆整理(sleep)任务(M6;生成日志已由 #43 完成)、按项目分区、M10 记忆簇与会话地图可视化 |
| 本地文件 | 授权目录内读/写/搜索、PDF/Office/图片解析、本地知识库 RAG | 文件监听自动入库、OCR |
| 邮件 | IMAP 收、SMTP 发(发送需确认)、摘要、草稿 | Gmail/Outlook OAuth、规则自动化 |
| 语音 | STT(云端 API 或本地 whisper)、TTS、按住说话 | 实时语音对话、唤醒词(桌面) |
| 工具/插件 | 内置工具 + MCP 客户端(stdio / Streamable HTTP)| 插件市场、插件签名、沙箱 |
| 渠道 | Web UI、CLI、企业微信机器人、微信(iLink/ClawBot)| QQ 官方机器人(1.x 优先)、Telegram、Slack、飞书、钉钉、邮件作为渠道 |
| 知识地图 | 统一条目表 + 父子关系表 + REST 层级查询 API;Web UI 列表/树形分类浏览器(逐层下钻、面包屑、打开条目、「问 AI」)| 桌面粒子球钻取导航(M10)、移动端复用;插件可注册条目来源 |
| 账户 | 单用户(一个主人账户,多设备/多渠道)| 多用户与数据隔离(2.0)|
| 远程 | 服务器 Docker 部署、HTTPS、登录鉴权 | 桌面⇄手机配对、Tailscale/自建中继、PWA |
| 自动化 | —— | 定时任务(cron)、事件触发、主动推送 |
| 多智能体 | —— | 子代理委派、角色/人格、并行任务 |
| 桌面 | —— | Tauri 安装包(Win/macOS/Linux,暂不做付费代码签名)、托盘、全局快捷键、自动更新、知识地图粒子球 |
| 国际化 | 中/英双语界面骨架 | 完整 i18n、文档双语 |

---

## 3. 技术栈对比与推荐

### 3.1 评估维度
1. **桌面打包**:安装包体积、启动速度、跨平台、签名/自动更新难度。
2. **2GB 服务器常驻内存**:空闲 RSS、峰值。
3. **AI/Agent 生态**:LLM SDK、MCP SDK、Agent 框架成熟度。
4. **插件生态覆盖**:社区插件作者最常用的语言、MCP Server 的主流实现语言。
5. **本地 AI 能力**:本地语音、嵌入、文档解析。
6. **开发效率**:前后端是否同语言、类型共享、由 Claude Code 编写时的熟练度。

### 3.2 三种语言对比

| 维度 | **TypeScript(Node)** | **Python** | **Java(Spring AI 2.0)** |
|---|---|---|---|
| Agent / LLM 生态 | 很强:Vercel AI SDK 7(ToolLoopAgent、工具审批、语音 API)、官方 MCP TS SDK(MCP 的参考实现)、OpenAI/Anthropic 官方 SDK | 最强:LangGraph、PydanticAI、LlamaIndex、官方各家 SDK、MCP Python SDK | 不错:Spring AI 2.0(2026-06 GA,含官方 MCP Java SDK 2.0)、LangChain4j;企业味重 |
| 前后端同语言 | **是**:UI、核心、插件、类型共享 | 否:UI 仍需 TS | 否:UI 仍需 TS |
| 桌面打包 | Tauri 壳(约 10MB)+ Node sidecar(SEA 或附带 node 二进制,约 40–70MB 压缩后);或 Electron(约 100–150MB) | Tauri 壳 + PyInstaller/Nuitka sidecar(含依赖常 60–200MB,一旦带上 torch 就是 GB 级);冷启动慢,杀软误报较多 | 需捆绑 JRE:jlink 精简后约 50–80MB,加 Spring Boot 常 ≥100MB;GraalVM Native Image 可缩小,但 Spring AI 反射/动态代理多,原生编译坑多、构建慢 |
| 2GB 服务器空闲内存 | 约 80–150MB | 约 100–200MB(不加载本地模型) | 约 300–500MB(需 -Xmx512m 级别调优)|
| 插件生态覆盖 | npm 最大的包生态;MCP Server 主流语言之一;前端插件(UI 扩展)只能用 JS/TS | MCP Server 另一主流语言;数据/ML 脚本作者多 | Java 写个人工具插件的人很少 |
| 本地 AI(语音/嵌入/解析)| 中:onnxruntime-node、sherpa-onnx(Node 绑定)、transformers.js;PDF/Office 解析库可用但弱于 Python | **最强**:faster-whisper、sentence-transformers、unstructured、docling 等 | 弱 |
| 并发/IO(多渠道长连接)| 强(事件循环天然适合 IM 长轮询/WebSocket)| 强(asyncio)| 强(虚拟线程)|
| 移动端/远程 | 同一套 React UI 可做 PWA,Tauri v2 可出 iOS/Android | 同上(UI 仍是 TS)| 同上 |
| Claude Code 编写熟练度 | 很高 | 很高 | 高 |

### 3.3 桌面打包方案细比

| 方案 | 体积 | 内存 | 优点 | 风险 |
|---|---|---|---|---|
| **Tauri v2 + Node sidecar** | 壳 ~10MB + Node 运行时 ~40–70MB | 系统 WebView,内存省 | 体积小、Rust 侧可做托盘/快捷键/自动更新/签名;v2 支持 sidecar 和移动端 | Linux 用 WebKitGTK,渲染差异需测;Node SEA 在官方文档中仍标为「1.1 积极开发」,需锁定 Node 版本(备选:直接随包附带 node 可执行文件 + 打包好的 JS)|
| Electron | ~100–150MB | 较高(自带 Chromium)| 渲染一致、生态成熟、Node 内置无需 sidecar | 体积/内存大,与「轻量」定位不符 |
| Tauri v2 + Python sidecar(PyInstaller)| 壳 + 60–200MB | 中 | 可直接用 Python AI 库 | 冷启动 2–5s、杀软误报、跨平台构建矩阵复杂、原生依赖(numpy 等)易出问题 |
| Java + jpackage / GraalVM | ≥100MB(JRE)| 高 | 企业熟悉 | 就是业主担心的点:JRE 笨重,Native Image 与 Spring 动态特性冲突 |

### 3.4 结论:选 TypeScript 单仓 + Tauri v2

**推荐:TypeScript monorepo —— Node.js 核心(apps/server)+ React Web UI(apps/web)+ Tauri v2 桌面壳(apps/desktop,核心作为 sidecar)。**

理由:
1. **一门语言贯穿全部**:核心、Web UI、桌面前端、插件 SDK、类型定义共享(zod schema 一次定义,前后端/工具参数/配置校验通用)。对于主要靠 Claude Code 开发的一人项目,减少语言边界 = 减少 bug 和上下文切换。
2. **桌面打包最轻**:Tauri 壳 ~10MB,Node sidecar 几十 MB,整体安装包目标 ≤ 80MB,远小于 Java(≥100MB)和 Electron。
3. **2GB 服务器友好**:同一个 core 用 Docker(node:22/24-slim)部署,空闲 ~100–150MB,不用像 Java 那样卡 -Xmx。
4. **插件生态覆盖面最大**:npm 生态 + MCP TS SDK 是 MCP 的参考实现;而且 **MCP 通过 stdio/HTTP 与语言无关**——Python 写的 MCP Server 照样能接,所以选 TS 并不排斥 Python 插件。
5. **IM 渠道/长连接/流式输出**:Node 事件循环天然合适。
6. **移动端**:同一套 React UI 先做 PWA;原生 iOS/Android 客户端(Tauri v2 mobile 或 Swift/Kotlin 原生)以后只需对接 API v1,选型可届时再定。

> 说明:桌面和移动属于阶段二,但仍是选型的重要约束——选 TS + Tauri 是为了以后打包时不返工;阶段一只交付 headless 核心 + Web UI + CLI + IM 渠道。

**主要取舍(要承认的短板)与缓解:**
- **本地 AI 库弱于 Python**(本地 whisper、嵌入模型、复杂文档解析)。缓解:
  - 默认走 API(用户自己的 OpenAI 兼容端点,含 STT/TTS/嵌入);
  - 本地 STT/TTS 用 sherpa-onnx 的 Node 绑定或 whisper.cpp 二进制作为可选组件;本地嵌入用 transformers.js / onnxruntime-node 跑小模型;
  - **预留「Python worker」可选扩展**:需要 Python 生态的能力(如 docling 文档解析、faster-whisper)以独立 MCP Server 形式提供,用户按需安装,核心不依赖 Python。
- **Node SEA 仍非稳定特性**:CI 中锁定 Node LTS 版本构建;若 SEA 出问题,退回「附带官方 node 二进制 + bundle.mjs」方案(体积几乎相同)。
- **Linux WebKitGTK 渲染差异**:UI 避免过新的 CSS 特性;CI 用 Playwright 在 WebKit 下跑 E2E。若长期不可接受,Electron 作为 Plan B(核心与 UI 不变,只换壳)。

**为什么不是 Python 核心 + Tauri**:它是第二候选,AI 库最强;但前端仍需 TS(两种语言)、PyInstaller sidecar 体积和启动慢、跨平台原生依赖维护成本高。若未来本地模型成为核心卖点,可通过上面的 Python worker 渐进引入,而不必重写核心。

**为什么不是 Java(Spring AI)**:Spring AI 2.0 本身很成熟,但桌面需捆绑 JRE(≥100MB)、空闲内存高(2GB 机器上要压 -Xmx512m)、个人工具类插件作者极少使用 Java。

### 3.5 具体选型清单

| 层 | 选型 | 备注 |
|---|---|---|
| 运行时 | Node.js 24 LTS(最低 22)| ESM only;`"type": "module"` |
| 包管理/单仓 | pnpm workspaces + Turborepo | |
| 语言/校验 | TypeScript strict + zod | 共享 schema |
| HTTP/WS 服务 | Hono(@hono/node-server)| 轻量;SSE 流式 + WebSocket |
| LLM 层 | 自有 `ModelProvider` 接口;OpenAI 兼容端点用 fetch + SSE 自写(AI SDK 7 加载即增加约 22 MiB RSS,见 ADR 0006);Anthropic / Gemini 原生适配届时评估,若用 SDK 则按需动态加载 | 避免强绑定,守住 2GB 内存预算 |
| MCP | `@modelcontextprotocol/sdk`(客户端 + 自身也暴露 MCP Server)| stdio + Streamable HTTP |
| 存储 | SQLite(better-sqlite3,手写参数化 SQL + 自写迁移器)+ sqlite-vec(向量)| 单文件,备份简单;不用 ORM:drizzle-orm 0.45 仅加载就占约 140MB 堆(ADR 0005);Node 内置 `node:sqlite` 转稳定后可替换 |
| 任务调度 | 自研轻量调度器(cron 表达式用 `croner`)+ SQLite 持久化 | |
| Web UI | React 19 + Vite + TanStack Router/Query + Tailwind + shadcn/ui | |
| 桌面 | Tauri v2(Rust)+ sidecar(Node SEA / 附带 node)| 托盘、快捷键、自动更新、深链接 |
| 移动 | PWA 先行 → Tauri v2 mobile | |
| 知识地图渲染 | 1.0:React 树/列表(虚拟滚动,TanStack Virtual);M10:Three.js 粒子球(复用 VoiceOrb 渲染层)| 两者共用同一套 `/api/v1/items` REST API |
| CLI | `apps/cli`(citty 或 commander)| |
| 邮件 | imapflow + nodemailer + mailparser | |
| 文件解析 | pdfjs-dist、mammoth(docx)、xlsx(SheetJS)、可选 Python worker | |
| 语音 | API 优先(OpenAI 兼容 /audio/transcriptions, /audio/speech);可选 sherpa-onnx / whisper.cpp | |
| 测试 | Vitest、Playwright、msw(HTTP mock)、自研 LLM 录制回放 | |
| 日志 | pino(本地文件,轮转)| 不外传 |
| 文档站 | Astro Starlight(中/英)| GitHub Pages / 自有域名 |
| CI/CD | GitHub Actions:lint/test/build、Docker 镜像(GHCR)、Tauri 多平台构建、release-please | |

---

## 4. 总体架构

```
            ┌───────────── 外壳/渠道(Clients & Channels)─────────────┐
            │ Web UI │ Tauri 桌面 │ PWA/手机 │ CLI │ 企业微信 │ 微信 │ (QQ 1.x)│
            └────┬──────────┬─────────┬───────┬──────────┬────────────┘
                 │ HTTP/SSE/WS(统一 API + 鉴权)        │ Channel Adapter
            ┌────▼────────────────────────────────────────▼───────────┐
            │                  core(apps/server)                     │
            │  Gateway(鉴权/限流/会话) → Agent Runtime(工具循环/审批)  │
            │  ├─ Model Router(BYO 多配置档)                          │
            │  ├─ Tool Registry(内置工具 + MCP 客户端 + 插件)           │
            │  ├─ Memory(有类型记忆+出处) ├─ Knowledge(本地文件 RAG)  │
            │  ├─ Item Index(统一条目 + 父子关系 → 知识地图)          │
            │  ├─ Scheduler(定时/事件) ├─ Permission & Audit          │
            │  └─ Storage(SQLite + 数据目录)                           │
            └──────────────────────────────────────────────────────────┘
                 │ stdio / Streamable HTTP
            ┌────▼─────────┐   ┌───────────────┐
            │ MCP Servers  │   │ Python worker │(可选)
            └──────────────┘   └───────────────┘
```

关键设计:
- **单进程核心**:默认一个 Node 进程即可;重活(文件索引、嵌入)放 worker_threads。
- **统一事件流**:Agent 每一步(文本增量、工具调用、待审批、错误)都作为事件写入 SQLite 并推送到订阅的客户端,渠道适配器同样消费这些事件 → 天然支持断线续传、多端同步。
- **统一条目索引(Item Index)**:邮件、文件/小说、人物、视频数据等各来源的「条目提供者(ItemProvider)」把内容登记到同一张 `items` 表,层级关系写入 `item_edges` 表;知识地图、搜索、「问 AI」都基于它(见 6.2)。
- **工具审批**:工具声明 `risk: read | write | external | dangerous`;`write/external/dangerous` 默认需要用户在任一已登录客户端确认(IM 渠道里回复「确认」或点击卡片)。
- **数据目录**:`~/.fatcat-ai/`(桌面)或 `/data`(Docker):`config.yaml`、`db.sqlite`、`files/`、`logs/`、`plugins/`。API Key 存系统钥匙串(桌面,Tauri keyring 插件)或加密存储(服务器,主密钥来自环境变量)。

---

### 4.1 Web UI 要点、语音状态指示器与知识地图

Web UI(以及以后的桌面/移动客户端)只是 API 客户端。除聊天、设置、审批、任务、插件页外,增加一个**语音/代理状态指示器**组件(`packages/ui/VoiceOrb`,M4 交付,桌面「快速提问」小窗与移动端复用):

- **状态来源**:core 通过 WebSocket 推送 `assistant-state` 事件(见 6.1),前端不自行推断:
  `{ type: 'assistant-state', state: 'idle'|'listening'|'thinking'|'speaking'|'executing', label?: string, toolName?: string, level?: number /* 0–1,TTS 输出电平,可选 */ }`
  - `idle`:空闲;`listening`:正在收音/STT;`thinking`:模型推理中(首 token 前或推理流);`speaking`:TTS 播放中;`executing`:工具执行中。
  - `label`:状态文字,由 core 按当前语言生成,如「正在聆听…」「思考中…」「正在操作浏览器」「正在读取邮件」;工具在 ToolDef 中可声明 `activityLabel`(i18n key),executing 时使用。
  - 状态变化去抖(≥150ms 才切换),避免闪烁;多端同时在线时都收到同一状态。
- **渲染**:粒子球体。优先 Three.js(`THREE.Points` + 自定义着色器,约 2–4k 粒子);不支持 WebGL 或开启「减少动态效果」时回退到 Canvas 2D 简化版(或静态圆点)。组件按需懒加载,不影响首屏。
- **颜色映射**(CSS 变量可主题化,深浅色均需对比度达标):
  - 绿色 = `listening` / `idle`(idle 低亮度、缓慢呼吸;listening 高亮)
  - 紫色 = `thinking`(粒子缓慢旋转/流动)
  - 蓝色 = `speaking` / `executing`(executing 时粒子轨道式转动)
  - 颜色切换用 300–500ms 插值过渡。
- **随音频脉动**:`listening` 时用麦克风 `AnalyserNode` 的 RMS 电平(本地计算,不上传);`speaking` 时用 TTS 播放音频的 `AnalyserNode`,或 core 推送的 `level`;电平映射为球体半径/粒子位移幅度(平滑处理,如指数移动平均)。
- **状态文字行**:球体下方一行文字显示 `label`(如「正在操作浏览器」),`aria-live="polite"` 供屏幕阅读器播报;文字随 i18n 切换。
- **性能预算**:动画 60fps 目标,页面不可见时暂停渲染(`visibilitychange`),移动端粒子数减半;CPU 占用空闲态 < 3%。
- **测试**:状态机单测(事件序列 → 渲染状态);Playwright 截图测试各状态颜色;无 WebGL 回退测试。

#### 4.1.1 知识地图(钻取式分类导航)

把粒子球同时当作**层级导航**:每个粒子(簇)代表一个顶层类别(邮件、小说、人物、视频数据……),点击即展开为它的子类别,如此递归直到最深层的具体内容条目;在条目上可「打开」或「问 AI」。数据全部来自 6.2 节的条目表 + 关系表与 REST API,客户端不自行拼装层级。

- **v1.0(M2 起步,M5 完成)· 分类浏览器 `packages/ui/CategoryBrowser`**:Web UI 新增「知识地图」页,左侧树(懒加载子节点)+ 右侧列表(虚拟滚动、游标分页、按类型/时间排序);顶部面包屑(来自 `ancestors`);每个节点显示子项数与后代总数(来自 `counts`);条目详情页提供「打开」(按类型渲染:邮件正文、章节文本、文件预览、统计表)与「问 AI」(以该条目/子树为上下文新建会话)。移动端响应式。纯 REST,无需 WebSocket。
- **M10(桌面,数据结构稳定后)· 粒子球导航 `packages/ui/KnowledgeSphere`**:复用 VoiceOrb 的 Three.js 渲染层,但为独立组件:
  - 顶层:每个顶层类别 = 球面上一簇粒子(颜色按类别,大小按 `descendants` 数对数缩放),悬停显示名称与计数。
  - 点击某簇 → 相机推进、该簇「炸开」成新的一层球(子类别),其余淡出;面包屑与「返回上一层」(Esc / 双指捏合)同步;深层条目(叶子)显示为可点击的点,点击弹出详情卡(打开 / 问 AI)。
  - 每层最多渲染 N=200 个子节点,超出部分聚合为「更多…」粒子(对应分页游标);预取下一层用 `subtree?depth=2`。
  - 与语音指示器共存:AI 回答关于某条目的问题时,球体颜色按 `assistant-state` 切换,但层级位置不变。
  - 无障碍与回退:任何时刻可一键切换到树形视图(同一 API、同一选中状态);「减少动态效果」或无 WebGL 时默认树形视图。
  - 性能:单层 ≤ 200 个可交互簇、总粒子 ≤ 4k;切层动画 ≤ 600ms;空闲态 CPU < 3%。

## 5. 仓库结构

```
FatCat-AI/
├─ apps/
│  ├─ server/        # 核心服务(Node)
│  ├─ web/           # React Web UI(也被桌面和 PWA 复用)
│  ├─ desktop/       # Tauri v2 壳(src-tauri/ + 复用 web 构建产物)
│  ├─ cli/           # 命令行客户端
│  └─ docs/          # Astro Starlight 文档站
├─ packages/
│  ├─ shared/        # zod schema、类型、事件协议(Apache-2.0,供 SDK 依赖)
│  ├─ agent/         # Agent 运行时、工具循环、审批
│  ├─ providers/     # 模型适配(OpenAI 兼容/Anthropic/Gemini)
│  ├─ tools/         # 内置工具(fs、email、web_fetch、shell…)
│  ├─ memory/        # 记忆与向量检索
│  ├─ items/         # 统一条目索引:items + item_edges、ItemProvider、层级查询(知识地图)
│  ├─ storage/       # SQLite 连接(PRAGMA foreign_keys=ON)、迁移与备份、表定义与仓储(ADR 0005)
│  ├─ channels/      # 渠道适配器(1.0:wecom、wechat-ilink;之后:qq、telegram…)
│  ├─ plugin-sdk/    # 插件开发 SDK(对外发布到 npm,Apache-2.0)
│  ├─ client/        # API v1 客户端 SDK(TS,Apache-2.0;移动端按 OpenAPI 生成)
│  ├─ ui/            # 共享 UI 组件(VoiceOrb 语音指示器、CategoryBrowser 分类浏览器、KnowledgeSphere 粒子球导航[M10])
│  ├─ i18n/          # 文案资源
│  └─ eval/          # 评测框架与数据集
├─ docker/           # Dockerfile、compose、Caddy 示例
├─ .github/workflows/
├─ CLAUDE.md  AGENTS.md  CONTRIBUTING.md  SECURITY.md  LICENSE(AGPL-3.0 全文)  NOTICE  COMMERCIAL.md  CLA.md  TRADEMARKS.md
└─ README.md(中文) README.en.md
```

---

## 6. 核心接口(先定契约)

```ts
// packages/shared
export interface ModelProfile { id: string; label: string; kind: 'openai-compatible'|'anthropic'|'gemini';
  baseURL?: string; apiKeyRef: string; model: string; purpose: ('chat'|'cheap'|'embed'|'stt'|'tts')[]; }

export interface ToolDef<I, O> { name: string; description: string; input: ZodType<I>;
  risk: 'read'|'write'|'external'|'dangerous'; permissions?: Permission[];
  execute(input: I, ctx: ToolContext): Promise<O>; }

export type AgentEvent =
  | { type: 'text-delta'; runId: string; delta: string }
  | { type: 'tool-call'; runId: string; callId: string; name: string; input: unknown }
  | { type: 'approval-required'; runId: string; callId: string; summary: string }
  | { type: 'tool-result'; runId: string; callId: string; output: unknown; error?: string }
  | { type: 'run-finished'; runId: string; usage?: Usage }
  | { type: 'assistant-state'; state: 'idle'|'listening'|'thinking'|'speaking'|'executing'; label?: string; toolName?: string; level?: number }
  | { type: 'memory-used'; runId: string; ids: string[] };  // M2,见 ADR 0007;M1 另有 run-started / run-failed,见 ADR 0004

export interface ChannelAdapter { id: string; start(ctx: ChannelContext): Promise<void>; stop(): Promise<void>;
  send(target: ChannelTarget, msg: OutboundMessage): Promise<void>; }

// packages/shared · 知识地图(见 6.2)
export interface Item { id: string; kind: 'category'|'content'; type: string; /* 'mail.folder'|'mail.message'|'novel'|'novel.chapter'|'character'|'video.stats'|… */
  source: string; /* 提供者 id,如 'mail'、'files'、插件 id */ sourceRef?: string; title: string; summary?: string;
  icon?: string; color?: string; childCount: number; descendantCount: number; createdAt: string; updatedAt: string; meta?: Record<string, unknown>; }

export interface ItemEdge { parentId: string; childId: string; rel: 'contains'|'mentions'|'derived'|'supersedes'|'forked_from'; position?: number; primary: boolean; } // supersedes / forked_from 于 M2 加入(ADR 0007)

export interface ItemProvider { id: string; /* 由内置模块或插件注册 */
  roots(): Promise<ItemInput[]>;                       // 顶层类别,如「邮件」「小说」「人物」「视频数据」
  sync(ctx: ItemSyncContext): AsyncIterable<ItemChange>; // 增量登记 upsert/delete 条目与边
  open(item: Item, ctx: ToolContext): Promise<ItemContent>; } // 按类型返回可渲染内容(受权限约束)
```

HTTP API(v1,全部需要鉴权,OpenAPI 自动生成):
`POST /api/v1/sessions`、`POST /api/v1/sessions/:id/messages`(SSE 返回 AgentEvent)、`POST /api/v1/approvals/:callId`、`GET/PUT /api/v1/settings`、`/api/v1/models`、`/api/v1/memory`、`/api/v1/files`、`/api/v1/tasks`、`/api/v1/plugins`、`/api/v1/items`(知识地图,见 6.2)。另提供 **OpenAI 兼容的 `/v1/chat/completions`**(可选开启),让其他工具把 FatCat-AI 当模型端点用。

---

### 6.1 Headless 核心与客户端 API(为桌面/移动预留)

core 必须能在**没有任何 UI** 的情况下完整运行(`fatcat-ai serve`),所有能力都通过下列公开接口提供。Web UI 也只能用这些接口(禁止走内部捷径),以此保证未来的桌面/iOS/Android 客户端零改动接入。

- **版本化**:REST 统一前缀 `/api/v1`;WebSocket `GET /api/v1/ws`,握手时协商 `protocolVersion`;响应头带 `X-AIP-Server-Version`;`GET /api/v1/meta` 返回服务器版本、协议版本、已启用能力(capabilities 列表,如 `voice`、`email`、`tasks`),客户端按能力渐进显示功能。
- **契约优先**:zod schema → 自动生成 OpenAPI 3.1 文档(`/api/v1/openapi.json`)与 WebSocket 消息 JSON Schema;发布 `@fatcat-ai/client`(TS SDK),移动端可据 OpenAPI 生成 Swift/Kotlin 客户端。契约变更需在 CI 中通过「破坏性变更检测」(oasdiff)。
- **WebSocket 协议**:JSON 帧 `{v:1, type, id, seq, payload}`;服务器推送 AgentEvent、`assistant-state`(语音/代理状态,见 4.1)、审批请求、任务通知、会话同步;每条事件有单调递增 `seq`,客户端断线重连时带 `lastSeq` 拉取遗漏事件(事件已持久化在 SQLite);心跳 ping/pong 30s;同一账号多端同时在线,审批在任一端完成即同步到其他端。
- **移动端友好**:REST 分页统一用游标;附件走分片/断点续传上传(`/api/v1/uploads`);语音上传支持 `audio/webm`、`audio/mp4`(iOS)、`audio/ogg`;推送通知抽象为 `NotificationSink`(Web Push 先行,APNs/FCM 作为后续插件,通过可选的自建推送中继,不经第三方统计服务)。
- **鉴权**:设备配对流程(服务器生成一次性配对码/二维码 → 客户端换取设备令牌,`/api/v1/devices` 可查看/吊销);令牌为短期 access + 可轮换 refresh;支持 OAuth 2.1 设备授权式流程作为后续扩展。
- **离线与同步**:客户端可缓存会话列表与消息;服务器以 `updatedAt` + 游标提供增量同步接口 `/api/v1/sync`。
- **验收点(在 M1 就要满足)**:不启动 Web UI 也能用 CLI 或 `curl` + `websocat` 完成一次完整对话与审批;OpenAPI 文档可访问;有一个 WebSocket 断线重连补发事件的集成测试。
- **单用户**:1.0 只有一个主人账户;但所有表预留 `ownerId` 列(默认值为主人 id),为 2.0 多用户迁移留路,1.0 中不暴露任何多用户 API。

### 6.2 知识地图:统一条目表 + 父子关系表 + 层级查询 API

**数据模型(SQLite,手写 SQL 迁移;M1 建表,M2 落地 API)**
```sql
CREATE TABLE items (
  id TEXT PRIMARY KEY,            -- ULID
  owner_id TEXT NOT NULL,         -- 1.0 恒为主人 id,为 2.0 预留
  kind TEXT NOT NULL CHECK (kind IN ('category','content')),
  type TEXT NOT NULL,             -- 'mail.folder' | 'mail.message' | 'novel' | 'novel.chapter' | 'character' | 'video.stats' …
  source TEXT NOT NULL,           -- 提供者 id
  source_ref TEXT,                -- 提供者内部引用(邮件 UID、文件路径、外部 id),UNIQUE(source, source_ref)
  title TEXT NOT NULL, summary TEXT, icon TEXT, color TEXT,
  child_count INTEGER NOT NULL DEFAULT 0,       -- 缓存:直接子项数
  descendant_count INTEGER NOT NULL DEFAULT 0,  -- 缓存:后代条目总数(按 primary 边计)
  meta TEXT,                      -- JSON
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE item_edges (
  parent_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  child_id  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  rel TEXT NOT NULL DEFAULT 'contains',   -- 'contains' 构成导航树;'mentions'/'derived'/'supersedes'(新记忆→旧记忆)/'forked_from'(会话→会话)为交叉链接
  position INTEGER, primary_edge INTEGER NOT NULL DEFAULT 0,  -- 每个条目恰有一条 primary 'contains' 边(顶层类别除外)
  PRIMARY KEY (parent_id, child_id, rel)
);
CREATE INDEX idx_edges_child ON item_edges(child_id);
CREATE INDEX idx_items_type ON items(owner_id, type, updated_at);
```
- **导航树 = primary `contains` 边**(严格树,避免环);同一条目可通过非 primary 边出现在多个父节点下(如某人物既在「人物」下,也挂在多本小说下),UI 显示「也出现在…」。写入时检测环,拒绝。
- **顶层类别**:`kind='category'` 且无 primary 父边的条目;由各 ItemProvider 的 `roots()` 注册(内置:邮件、文件/文档、小说(按用户指定的文件夹识别)、人物(由记忆/知识库抽取)、会话;插件可注册如「视频数据」)。
- **层级查询**:祖先/子树用 SQLite 递归 CTE(`WITH RECURSIVE`)沿 primary 边查询;`child_count`/`descendant_count` 在 upsert/delete 时于同一事务内沿祖先链增量更新,并有定期校正任务(`items.recount`)。个人规模(十万级条目)无需闭包表;若基准测试中 `ancestors`/`subtree` P95 > 50ms 再引入闭包表(写 ADR)。
- **全文检索**:`items_fts`(SQLite FTS5,title + summary),中文用 trigram tokenizer;与知识库向量检索并列。
- **内容不复制**:条目只存元数据与摘要,正文仍在原处(邮件缓存、文件、插件),`open` 时由提供者读取并经权限检查。

**REST API(只读浏览全部是普通 REST,不依赖 WebSocket;支持 ETag / `If-None-Match`,可缓存)**
| 方法与路径 | 说明 |
|---|---|
| `GET /api/v1/items/roots` | 顶层类别列表(含 `childCount`、`descendantCount`、颜色/图标)|
| `GET /api/v1/items/:id` | 单个条目元数据 |
| `GET /api/v1/items/:id/children?cursor&limit=50&type&kind&sort=position\|title\|updatedAt&rel=contains` | 直接子项,游标分页 |
| `GET /api/v1/items/:id/ancestors` | 沿 primary 边到根的祖先链(面包屑,根在前);`?all=true` 额外返回经非 primary 边的其他路径 |
| `GET /api/v1/items/:id/counts` | `{ children, descendants, byType: { 'mail.message': 1203, … } }`(子树计数)|
| `GET /api/v1/items/:id/subtree?depth=2&limitPerNode=50` | 有限深度子树(粒子球预取下一层用;`depth ≤ 3`)|
| `GET /api/v1/items/:id/related` | 非 primary 边关联的条目(「也出现在…」、提及的人物等)|
| `GET /api/v1/items/:id/content` | 打开条目:由提供者返回可渲染内容(`text`/`markdown`/`html-sanitized`/`table`/`file` 链接),受工具权限约束 |
| `GET /api/v1/items/search?q&type&under=:id` | FTS 搜索,可限定在某子树内 |
| `GET /api/v1/items/changes?since=<cursor>` | 增量变更(轮询即可;移动端/离线缓存用)|
| `POST /api/v1/items/:id/ask` | 「问 AI」:以该条目(或 `scope: 'subtree'` 时整个子树摘要)为上下文创建会话,返回 `sessionId`;之后按普通会话 API(SSE)对话 |

- **Agent 工具**(risk=read):`items.roots`、`items.children`、`items.get`、`items.search`、`items.open`——让模型也能「沿地图找资料」;`items.open` 返回的内容一律标记为不可信外部内容(第 7 节)。
- **插件扩展**:`@fatcat-ai/plugin-sdk` 提供 `registerItemProvider()`(M7);1.0 内置提供者:`files`、`mail`、`novels`(文件夹规则)、`characters`(从知识库/记忆抽取,可手动编辑)、`sessions`。
- **测试**:树一致性属性测试(随机增删后 `descendant_count` 与递归计算一致、无环)、分页稳定性、权限(无权访问的路径不出现在 children 中)、10 万条目下 `children`/`ancestors`/`counts` P95 < 50ms(2GB 机器)。

## 7. 安全模型

- **鉴权**:首次启动生成管理员账户;Web 用 HttpOnly Cookie 会话 + CSRF;API/移动端用可吊销的个人访问令牌;支持 TOTP 二步验证;桌面本地模式只监听 127.0.0.1 并用随机令牌与壳通信。
- **网络暴露**:默认只监听 localhost;服务器部署须经反向代理(Caddy/Nginx)+ HTTPS(文档给出 Let's Encrypt + DNSPod DNS 验证示例)。
- **文件权限**:工具只能访问用户授权的目录列表;路径规范化 + 符号链接逃逸检查。
- **命令执行**:`shell` 工具默认关闭;开启后每次需审批,可选 Docker/bubblewrap 沙箱。
- **提示注入防护**:工具返回的外部内容(网页、邮件、文件)打上「不可信」标记,系统提示要求模型不得执行其中指令;对外发送(发邮件、发 IM 给第三方)一律需审批。
- **IM 渠道**:绑定「主人」身份(首个配对码验证的用户),非主人消息默认忽略或只读(1.0 单用户,系统中只有这一个主人)。
- **知识地图**:条目可见性遵循来源权限(未授权目录的文件不会被登记;撤销授权时级联软删除对应条目);`content` 接口复用工具权限检查与审计。
- **密钥**:API Key 不入日志、不回显;导出配置时脱敏。1.0 中模型配置档只保存 `env:` / `file:` 形式的密钥引用,API 与 Web UI 不接收明文 key;服务器端加密存储在 M5 加入(ADR 0006)。
- **记忆安全**:疑似凭据的内容一律拒存;银行卡号、身份证号、手机号等在写入记忆前即脱敏;邮件、网页、文件等外部内容不能直接成为记忆,只能由模型提议并经用户确认(《记忆模块补充设计》第 3 节)。
- **审计**:所有 write/external/dangerous 工具调用写审计日志,UI 可查。
- **依赖安全**:Renovate + `pnpm audit` + CodeQL 或 Semgrep(M5c 接入);发布产物附 SBOM 与签名(cosign / Tauri updater 签名)。

---

## 8. 里程碑(M0–M5:MVP 1.0,单用户)

> 每个里程碑:先写/更新 `docs/adr/` 下的设计记录 → 实现 → 测试 → 更新文档 → 打 tag。估时按「Claude Code 主力开发 + 业主审阅」粗估。

### M0 · 脚手架与工程基线(约 2–3 天)
- pnpm + Turborepo 单仓;TS strict、ESLint(flat config)+ Prettier、Vitest、Changesets 或 release-please。
- `apps/server` 最小 Hono 服务(`/healthz`)、`apps/web` Vite 空壳、`packages/shared`。
- CLAUDE.md / AGENTS.md(写清命令、目录约定、提交规范)、LICENSE(AGPL-3.0 全文,从 https://www.gnu.org/licenses/agpl-3.0.txt 原样复制,勿改动)、NOTICE(`Copyright (C) 2026 尹绪柏 (Theodore Yin)` + 双许可说明)、COMMERCIAL.md(联系邮箱 x19169738916@163.com)、CLA.md、TRADEMARKS.md、CONTRIBUTING、SECURITY(漏洞报告邮箱 x19169738916@163.com)、Issue/PR 模板;根 `package.json` 与各包 `"author": "尹绪柏 (Theodore Yin) <x19169738916@163.com>"`;SDK 包(`plugin-sdk`、`client`、`shared`)放 Apache-2.0 LICENSE;所有源文件加 SPDX 头;接入 CLA Assistant;Web UI「关于」页与页脚放源码链接(AGPL §13);CI 检查 SPDX 头、CLA 签署与依赖许可证(见第 15 节)。
- GitHub Actions:lint + typecheck + test + build;Dockerfile(多阶段,node slim,非 root)。
- **验收**:`pnpm i && pnpm dev` 同时起 server 和 web;`docker compose up` 后 `/healthz` 返回 200;CI 全绿;镜像空闲 RSS < 120MB(历史门禁,M3.x 起由 ADR 0018 的内存预算替换)。

### M1 · 对话核心 + BYO LLM(约 1 周)
- 模型配置档 CRUD(只能填 `env:` / `file:` 密钥引用),连接测试按钮(调 `/models` 或发一次最小请求);OpenAI 兼容 / Anthropic / Gemini 适配(后两者为最后一个 PR,进度紧可移到 M1.x)。
- `packages/storage`:SQLite 连接(每个连接 `PRAGMA foreign_keys = ON`)、迁移与备份(ADR 0005)。
- 会话与消息存储(SQLite + 手写 SQL 迁移,`packages/storage`);流式输出(SSE);中断/重试/重新生成;上下文窗口管理(超长时用 cheap 模型做摘要压缩)。
- Web UI:会话列表、聊天窗口(Markdown、代码高亮、复制)、设置页、深浅色、中英文切换骨架。
- 鉴权:主人账户初始化(1.0 单用户,无注册/多账户)、登录、令牌;表结构预留 `ownerId`;TOTP 推迟到 M5。`/api/v1/openapi.json` 需要鉴权,CI 另导出静态文件(ADR 0004)。
- 长期记忆 v1:模型可调用 `memory.save / memory.search`(`memory.save` 默认需要审批,借此实现最小审批管道);UI 可查看/编辑/删除。按 ADR 0007 提前建 `items` / `item_edges` / `items_fts`(只建表)与 `memory_facts` 子集,M2 只做增量迁移。
- **验收**:填入任意 OpenAI 兼容端点(含 Ollama)即可流式对话;刷新页面可续看进行中的回复;未登录访问 API 返回 401;单测覆盖 providers 与会话存储;录制回放测试通过。

### M2 · 工具框架 + 本地文件(约 1–1.5 周)
- Tool Registry、风险分级与审批流(UI 弹窗 + API)、审计日志。
- 内置工具:`fs.list/read/write/search/move`(限授权目录)、`web.fetch`(可选 `web.search` 对接用户自填的搜索 API)、`time`、`calc`。
- 文档解析:PDF、DOCX、XLSX、Markdown、图片(交给多模态模型)。
- 本地知识库:选择文件夹 → 分块 → 嵌入(用户的 embed 配置档)→ sqlite-vec 检索;引用来源可点击。
- MCP 客户端:配置 stdio / Streamable HTTP 服务器,工具自动注册,遵循同一审批流。
- **记忆 v2 核心(见《记忆模块补充设计》第 9 节、ADR 0007,约增加 4–6 天)**:写入路径(凭据拒存、抽取、去重、更替、冲突)、FTS+向量+图三路召回与 RRF、可信度说明与 token 预算、会话开头 digest、衰减 / 分层 / 过期 / 清理任务(sleep 整理放 M2 还是 M6 待定)、反馈闭环、`/api/v1/memory` 全集、`memory` ItemProvider、会话 fork API、Web 记忆页与「本次用到的记忆」面板;验收见补充设计第 9 节 ①–⑧。
- **统一条目索引 v1(知识地图数据层,见 6.2)**:`items` + `item_edges` + `items_fts` 已在 M1 建表,本里程碑补齐计数维护、ItemProvider 等;ItemProvider 接口;内置 `files`、`novels`、`sessions` 提供者;REST:`roots`/`:id`/`children`/`ancestors`/`counts`/`subtree`/`content`/`search`/`changes`;Agent 工具 `items.*`。Web UI 先出最简树形浏览(只读)。
- **验收**:「总结 ~/Docs/某 PDF 并另存为 md」需一次审批后完成;越权路径被拒绝且有审计记录;接入一个官方示例 MCP Server(如 filesystem 或 fetch)可用;路径逃逸测试用例全部通过;授权一个含小说的文件夹后,知识地图可「小说 → 某书 → 某章」逐层下钻并打开,计数与递归计算一致。

### M3 · 邮件(约 1 周)
- 账户配置:IMAP/SMTP(含 QQ 邮箱/163/Gmail 应用专用密码说明)。
- 工具:`mail.list/search/read/summarize/draft/send`;`send` 一律审批,审批卡片展示收件人/主题/正文。
- 增量同步(UID + IDLE 或定时拉取),本地缓存正文与附件索引;附件可进入知识库。
- `mail` ItemProvider:「邮件 → 账户 → 文件夹 → 会话串 → 邮件」登记到条目索引;从邮件中识别的联系人可挂到「人物」下(非 primary 边)。
- **验收**:能「总结今天未读邮件」「按要求起草回复并在确认后发送」;邮件内容中的注入指令不会触发发送(有专门的评测用例);知识地图中可钻取到单封邮件并「问 AI」。

### M3.x · 清理(M4 之前做,业主 2026-11-10 决定)
- 邮件:旧账户迁移(迁移 0011)与显式 `sentCopy: append` / `off` 由助手在真机上测,不另写自动测试;写一个合成的 1 万封邮件同步压测;Web 设置页加 `sentCopy` 开关。
- 内存:查清万封同步后主进程 RSS 从 91.7 MiB 涨到 161.8 MiB(业主侧助手的合成测试,测的是测试脚本父进程,不是完整产品或容器)、同步结束后不回落的原因并修复(回落要求见第 12 节)。
- 内存预算 ADR(ADR 0018):写清 20% 涨幅是让 CI 失败还是只报警、何时删除 `ci.yml` 里固定的 120 MiB 门禁;ADR 合并后再改 CI。第 11、12 节的新内存预算在这份 ADR 落地后生效。
- 记忆:Web 设置页加记忆「自动抽取」开关(`memory.autoExtract`),支持一键关闭;记忆页显示每条记忆的生成来源 `extractRun`(模型、状态、时间)。
- M1 / M2 遗留:Web 代码高亮;覆盖率门禁从 `tools` 扩大到其他核心包。
- **验收**:上面各项完成;旧账户迁移与 `append` / `off` 的真机结果写进 M3 自检报告;万封同步后内存能回落。

### M4 · 语音(约 1 周)
- STT:优先用户配置的 `/audio/transcriptions` 端点;可选本地组件(sherpa-onnx 或 whisper.cpp,独立下载)。
- TTS:`/audio/speech` 端点;可选本地 TTS。
- Web/桌面:按住说话、语音消息、朗读回复;**语音状态指示器(粒子球 + 状态文字,见 4.1)**,core 在收音/推理/朗读/执行工具时推送 `assistant-state`;IM 渠道:接收语音消息转写、可回语音。
- **图片交给多模态模型**(M2 推迟项,和语音一起做):先写网关契约 ADR,把 `ChatMessage.content` 改成多段内容(文本 / 图片 / 音频),再实现。
- **验收**:浏览器中按住说话 → 转写 → 回复 → 朗读全流程 < 端点延迟 + 1s 额外开销;指示器在五种状态下颜色与文字正确,随音量脉动,无 WebGL 时正常回退;无本地组件时自动回退到 API。

### M5 · 渠道(企业微信 + 微信)、知识地图分类浏览器与远程访问 → 发布 v1.0

> 业主 2026-11-10 决定拆成 M5a / M5b / M5c 三段,每段单独自检。三段都完成才发布 v1.0。

### M5a · 渠道框架 + 企业微信 + 微信 iLink(约 1–1.5 周)
- **开头先写 ADR:`memory-used` 降级标记**:`memory-used` 事件增加可选字段 `degraded`(说明召回超时后跳过了哪一路);先 ADR、后实现(改 `packages/shared` 事件协议,见第 13 节第 2 条)。同时把 `omitted` 带进事件(目前只在检索结果里)。召回超时本身已在 #42 完成(向量这一路 400 ms,超时只用全文 + 图;全文与图是本地同步查询,所以不另设总时限)。设计见 ADR 0017。
- 渠道适配器框架(统一 inbound/outbound、主人绑定、审批交互、富文本降级)。
- **企业微信**(业主 2026-11-11 决定推迟,排期另定;M5a 先做框架与微信):自建应用/群机器人回调(消息加解密、被动回复 + 主动推送)。
- **微信个人号**:基于腾讯官方 iLink / ClawBot 协议(扫码授权、长轮询),参考第三方公开项目的 README 与协议说明(腾讯微信官方 npm 包 `@tencent-weixin/openclaw-weixin`、`gfydfhcf/wechat-ilink-muse-bridge`,均为 MIT;按净室规则不读源代码,见 ADR 0022 第 13 节);不使用非官方 hook 协议。
- **用户时区设置**:主人可设置时区;「今天」、维护任务、以后的定时任务都按它计算。写 ADR 说明服务器、用户、IM 对方三方时区不一致时以哪个为准,**默认按用户设置的时区**。
- **渠道注入评测**(仿照邮件的 14 条用例):非主人消息、群聊消息、转发内容一律视为不可信,验证它们触发不了外发、也绕不过审批;另加一条:敏感度高于 1 的记忆不出现在群聊回复和 digest 里。
- 内存:实测每个渠道(尤其微信长轮询)的内存开销,据此定每个渠道的增量上限(第 12 节)。
- **验收**:**企业微信与微信两个渠道**均可收发并完成一次审批;渠道注入评测全部通过;每个渠道的内存增量上限已写进 ADR 并有 CI 检查。

### M5b · 知识地图分类浏览器、人物与安全加固(约 1 周)
- **知识地图分类浏览器(v1.0 版,见 4.1.1)**:`CategoryBrowser` 完整版——懒加载树 + 虚拟滚动列表 + 面包屑 + 计数徽标 + 条目详情(打开 / 问 AI)+ 子树内搜索 + 手机响应式;`characters` 提供者;从邮件识别的联系人挂到「人物」下(M3 推迟项,非 primary 边);IM 渠道支持 `/map` 指令(文本列出顶层类别与子项编号,回复编号下钻)。粒子球导航**不在 1.0 范围**,留到 M10。
- **TOTP 两步验证与密钥加密存储(M1 推迟项)**:**公网 HTTPS 暴露前的硬性要求**——没有完成这两项,部署文档不推荐对公网开放。
- **零遥测落地(第 10 节)**:设置页列出全部外连目标(模型端点、邮箱、渠道、插件、更新检查)。
- **验收**:Web UI 知识地图可从任一顶层类别(邮件/小说/人物)下钻到最深条目并打开或「问 AI」,全程只用 REST;开启 TOTP 后无第二因素无法登录;数据库中找不到明文密钥;设置页的外连目标清单与实际外连一致。

### M5c · 部署与发布(约 0.5 周)
- **冻结 `/api/v1` 前**:oasdiff 兼容性检查已在 CI 中(`openapi-compat` 任务,ADR 0010 第 10 节,PR 上比较基线与本分支的 `apps/server/openapi/v1.json`,破坏性修改直接失败);冻结前复核它覆盖 `/api/v1` 的全部路径;CI 补上 CodeQL 或 Semgrep(第 11 节)。
- 远程:Docker 一键部署文档(2GB 机器配置建议、Caddy 自动 HTTPS、DNSPod DNS 验证示例);Web UI 响应式适配手机。
- 发布:Docker 镜像(amd64/arm64)到 GHCR、v1.0 Release Notes、README 快速开始;按 ADR 0018 把内存基线更新为 v1.0 的实测值。
- **验收**:在 2C2G 机器上 `docker compose up -d` 后,通过 HTTPS 域名登录使用;内存满足第 12 节的预算:不配置渠道时空闲 ≤ 250 MiB,每个渠道不超过 M5a 定的增量上限,长时间运行与万封同步后能回落,与上一版本相比涨幅不超过 20%;对话中峰值 < 400 MiB。

---

## 9. 1.0 之后的路线图(M6–M12)

> 阶段一(框架)继续完善 M6–M9;阶段二(客户端)M10–M11 在 API v1 稳定后启动;阶段三 M12。

### 阶段一(续)· 框架

### M6 · 定时任务与自动化(约 1.5 周)
- 任务模型:触发器(cron / 一次性时间 / 事件:新邮件、文件变化、Webhook)+ 动作(一段提示词交给 Agent,或固定工具链)+ 输出去向(会话、IM 渠道推送、邮件)。
- 自然语言创建:「每天早上 8 点把未读邮件摘要发到微信」→ 解析为任务并让用户确认。
- 运行记录、失败重试、并发限制、静默时段;离线错过的任务按策略补跑或跳过。
- **记忆整理与生成溯源**(记忆的 L2 层;对照 TencentDB Agent Memory 后补入,ADR 0007 第 5.1 节):
  - `memory.sleep` 整理:产物仍是 `memory_facts(origin = 'consolidated')`,建 `derived` 边,走同一条写入路径(凭据拒存、脱敏、sensitivity、不可信来源进隔离区);digest 继续按规则生成,不用 LLM 改写画像。
  - 生成日志(**已完成**,#43,迁移 0012):新增 `memory_extract_runs`(运行 id、会话 / run、配置档与模型、`prompt_version` = 提示词哈希、状态、写入 / 隔离 / 拒存计数、错误码),自动抽取与 sleep 都写这张表;`memory_sources` 加可为空的 `extract_run_id`;`GET /memory/{id}/sources` 返回这次运行的信息。只存 id、计数和错误码,不存正文或模型输出。
- **验收**:任务在重启后持久;时区正确(用户时区可配);推送到渠道成功;无人值守任务中的高风险工具仍按策略审批(可设置「预授权」白名单)。

### M7 · 插件系统与插件市场(约 2–3 周)
- 插件形式:① MCP Server(任意语言,首选);② 原生 TS 插件(`@fatcat-ai/plugin-sdk`,Apache-2.0:注册工具、渠道、**知识地图条目提供者 `registerItemProvider`**(如「视频数据」)、设置页 UI 片段、定时任务模板)。
- 清单 `plugin.json`:名称、版本、权限声明、入口、i18n 文案、最低核心版本。
- 安装来源:npm 包、Git 仓库、本地目录;市场 = 一个公开的 GitHub 索引仓库(JSON 索引 + PR 审核),客户端从中浏览/搜索/安装。
- 安全:安装时展示权限;原生插件运行在独立进程(子进程/worker + 受限 API),不直接拿到密钥;索引条目附校验和,可选 sigstore 签名。
- **验收**:可从市场一键安装一个 MCP 插件和一个原生插件;卸载干净;越权调用被拦截。

### M8 · 多智能体(约 2 周)
- 「代理」=人格/系统提示 + 模型配置档 + 工具白名单 + 记忆分区。
- 主代理可委派子代理(`delegate` 工具),子任务可并行,结果汇总;深度与预算(token/时间)上限。
- 预置角色:研究员(网页+知识库)、邮件秘书、文件管家、日程助手。
- 后台长任务:可在 UI 查看进度、取消、恢复(事件流持久化天然支持)。
- **验收**:「调研 X 并写成报告存到 ~/Reports」由主代理拆分为并行子任务完成;任何子代理不能越过自身工具白名单。

### M9 · 国际化与文档站(约 1–1.5 周,可与其他里程碑并行)
- i18n:界面文案全部抽到 `packages/i18n`(i18next / ICU 消息格式),首发 zh-CN、en;日期/数字本地化;系统提示词按语言提供模板;贡献新语言的流程文档。
- 文档站(Astro Starlight,中英双语):快速开始(Docker / 桌面 / 源码)、配置模型(含国内常见兼容端点示例)、渠道接入教程、插件开发指南、API 参考(由 OpenAPI 生成)、安全说明、FAQ、ADR 汇总、更新日志。
- **验收**:切换语言无硬编码中文/英文残留(CI 检查);文档站自动部署,搜索可用。

### 阶段二 · 客户端(后续阶段,依赖 API v1)

### M10 · 桌面应用 + 知识地图粒子球导航(约 3 周)
- 前置条件:API v1 已冻结,6.2 节条目数据结构经 1.0 实际使用后稳定(如有调整先写 ADR);桌面只是 6.1 节 API 的一个客户端 + 可选内嵌核心。
- Tauri v2 壳加载 `apps/web` 构建产物;核心以 sidecar 启动(Node SEA 产物;备选:附带 node 二进制 + bundle.mjs),壳负责进程守护、端口协商、随机令牌注入。
- 原生能力:系统托盘、全局快捷键唤起「快速提问」小窗、开机自启、系统通知、文件拖拽、深链接 `fatcat-ai://`、API Key 存系统钥匙串。
- **知识地图粒子球导航 `KnowledgeSphere`(见 4.1.1)**:顶层类别簇 → 点击展开子类别 → 递归至内容条目(打开 / 问 AI);面包屑、返回、键盘导航、与树形视图一键切换;仅用 `/api/v1/items/*` REST,`subtree?depth=2` 预取;Web UI 同步获得该组件(桌面优先打磨)。
- **记忆与会话可视化(见《记忆模块补充设计》第 7、9 节)**:粒子球中的记忆簇按类型着色、亮度表示置信度与分层、冲突描边;会话地图 2D 画布(fork 关系、点击定位到消息、与知识地图互跳)。
- 安装包:Windows(MSI/NSIS)、macOS(dmg)、Linux(AppImage/deb/rpm)。**暂不购买付费代码签名**:不做 Apple Developer ID 签名/公证、不买 Windows 代码签名证书;macOS 用 ad-hoc 签名,文档说明首次打开需「右键 → 打开」或 `xattr -dr com.apple.quarantine`,Windows 说明 SmartScreen「仍要运行」;发布页提供 SHA-256 校验和 + cosign 签名供核验。Tauri updater 自动更新照常使用(其更新签名免费,与系统代码签名无关,更新源为 GitHub Releases)。将来有需要再评估购买证书(写 ADR)。
- 「本地模式 ⇄ 连接远程服务器」切换:桌面既可自带核心,也可作为远程服务器的客户端。
- **验收**:三平台安装包 ≤ 80MB;冷启动到可对话 < 3s;关闭窗口驻留托盘,sidecar 随壳退出无残留进程;粒子球中从顶层类别点击下钻到最深条目(≥ 4 层)并「问 AI」,每次切层 ≤ 600ms,1 万条目数据集下 60fps;无 WebGL/减少动态效果时自动用树形视图;未签名安装包的安装说明经三平台实测。

### M11 · 移动端:PWA → iOS/Android(约 2–4 周)
- PWA:可安装、离线壳、Web Push 通知、语音输入。
- 桌面 ⇄ 手机配对:桌面生成二维码(含一次性配对码与地址),手机扫码获取令牌。
- 无公网 IP 场景:文档化 Tailscale / ZeroTier / Cloudflare Tunnel / frp 方案;可选自建轻量中继(端到端加密,中继只转发密文)。
- iOS/Android 原生客户端:基于 OpenAPI 生成的 SDK;技术路线届时二选一——Tauri v2 mobile(复用 React UI,省人力)或 Swift/Kotlin 原生(体验最好);推送用 APNs/FCM(经自建推送中继插件,默认关闭)。
- 前置条件:6.1 节的配对、增量同步、断点续传、推送抽象已在阶段一实现并有测试。
- **验收**:手机通过 PWA 与桌面本地实例或服务器实例对话、收到任务推送、完成一次审批。

### M12 · 稳定化与 2.0(持续)
- 性能:长会话、万级文件索引、多渠道并发下的内存与延迟基线;数据备份/恢复/迁移工具;配置导入导出。
- 可访问性(键盘操作、屏幕阅读器)。
- **多用户(2.0 核心目标)**:多账户、角色、数据按 `ownerId` 隔离(知识地图、记忆、渠道绑定各自独立)、1.0 单用户数据无损迁移。
- 更多渠道:**QQ 官方机器人(优先,可提前到 1.x)**、Telegram、Slack、飞书、钉钉;Gmail/Outlook OAuth、日历(CalDAV)。
- 治理:路线图公开(GitHub Projects)、贡献者指南、行为准则、版本与兼容性策略(semver,插件 API 稳定性承诺)。

---

## 10. 零遥测承诺(Telemetry-free)

- 代码中**不包含任何**统计/崩溃上报 SDK;CI 加一道依赖与网络调用检查(禁止已知遥测包,如 Sentry、PostHog、Segment 等进入生产依赖)。
- 程序只会主动连接:用户配置的模型端点、用户配置的邮箱/渠道/插件、(用户可关闭的)更新检查地址 GitHub Releases。设置页列出全部外连目标。
- 崩溃时生成本地诊断包(脱敏),由用户自行决定是否附到 Issue。
- README 与文档首页明确写出该承诺。

---

## 11. 测试与评测策略

| 层级 | 工具 | 内容 | 门禁 |
|---|---|---|---|
| 单元测试 | Vitest | 纯函数、schema、权限判定、路径校验、cron 计算 | 核心包覆盖率 ≥ 80% |
| 集成测试 | Vitest + msw + 临时 SQLite | API、工具执行、MCP 客户端(起示例 server)、IMAP/SMTP(GreenMail 或 mock 容器)| PR 必跑 |
| LLM 录制回放 | 自研 `packages/eval` 的 record/replay 适配器 | 首次真实调用录成 fixture,CI 中回放,保证确定性;可 `--live` 重录 | PR 必跑(回放模式)|
| E2E | Playwright(Chromium + WebKit)| 登录、对话、审批、文件工具、设置 | PR 必跑(冒烟)/ 夜间全量 |
| 桌面 | tauri-driver / WebDriver | 启动、sidecar 生命周期、托盘 | 发布前 |
| 评测(Evals)| `packages/eval`:YAML 用例 + 断言(包含/正则/工具调用序列/LLM 评审)| 工具选择正确率、任务完成率、**提示注入抵抗**(邮件/网页/文件中藏指令)、记忆召回、中文能力 | 夜间对用户指定的 1–2 个模型跑;发布前对比基线不得退化 |
| 记忆 | Vitest(单测 + 属性测试)+ 录制回放评测 | 凭据检测语料(正例召回 100%、误报 ≤5%)、脱敏、更替不变量(单值键最多 1 条 active、supersedes 无环)、级联删除清空来源/向量、FTS 回退、召回/更替/冲突/注入评测(≥30 条中文用例)、1 万条记忆 retrieve P95 <80ms | PR 必跑(回放模式)|
| 知识地图 | Vitest(属性测试)+ Playwright | 树一致性/无环/计数校正、分页稳定、权限过滤、10 万条目查询 P95;分类浏览器下钻 E2E;M10 粒子球交互 E2E | PR 必跑(回放数据集)|
| 性能 | 自研脚本 + autocannon | 空闲/峰值内存、长时间运行与万封同步后的内存回落、首 token 延迟开销、索引吞吐 | 内存预算 ADR 落地后:空闲内存每个 PR 跟上一版本对比,涨幅 > 10% 报警、> 20% 失败(ADR 0018);发布前跑全量与 2GB 预算检查 |
| 安全 | CodeQL 或 Semgrep、pnpm audit | 依赖与代码扫描 | PR 必跑(M5c 接入)|

评测原则:评测集随功能增长;每修一个 Agent 行为 bug,就加一条回归用例。

---

## 12. 部署与资源预算(2GB 服务器)

- `docker compose`:`fatcat-ai`(单容器)+ 可选 `caddy`。不引入 Postgres/Redis/向量库等额外服务(SQLite + sqlite-vec 足够个人规模)。
- 资源预算(业主 2026-11-10 改为防退化,不再卡死固定数字;细节见 ADR 0018;M3.x 起生效,CI 中固定的 120 MiB 门禁已删除):
  - 服务端空闲上限 **250 MiB**(不配置渠道时);每开一个渠道另定增量上限,在 M5a 实测微信长轮询的开销后再定;
  - 长时间运行和万封同步后,内存要能回落,不能持续上涨;
  - CI 跟上一个版本对比,按 ADR 0018:空闲内存涨幅 **> 10% 报警,> 20% 失败**,代替原来固定的 120 MiB 门禁;
  - 对话峰值 < 400 MiB;
  - 桌面端和手机端在 M10、M11 单独定预算,不跟服务端共用这个数字。
- 运行参数:Node 设置 `--max-old-space-size=384 --max-semi-space-size=8`(后者限制新生代,大批量写入后才能回落,见 ADR 0018);SQLite 页缓存 4 MiB;文件索引走 worker 并限制并发。
- 数据卷 `/data`;每日自动 SQLite 在线备份(保留 N 份);升级前自动备份。
- 与业主现有服务共存:默认端口可配,避免与代理服务冲突;文档提供 Caddy + Let's Encrypt(DNSPod DNS-01)示例。

---

## 13. 给 Claude Code 的工作约定(请写入仓库 CLAUDE.md)

1. **小步提交**:每个功能点一个分支/PR,Conventional Commits;PR 描述包含动机、改动、测试方式。
2. **先契约后实现**:改动 `packages/shared` 的 schema/事件协议前先写 ADR。
3. **测试先行**:新工具必须附带单测 + 至少一条评测用例;涉及审批/权限的改动必须有越权用例。
4. **不引入**:遥测 SDK、需要额外常驻服务的依赖、任何第三方 copyleft 依赖(GPL/LGPL/AGPL/SSPL 等:社区版虽兼容 AGPL,但作者无权把别人的 GPL 代码放进**商业许可版**,会破坏双许可);只允许 MIT/BSD/ISC/Apache-2.0/MPL-2.0(仅以未修改库形式使用)/0BSD/Unlicense 等宽松许可依赖(CI 用 license-checker 白名单检查)。
5. **许可证头**:每个新建源文件开头写 `// SPDX-License-Identifier: AGPL-3.0-only` 和 `// Copyright (C) 2026 尹绪柏 (Theodore Yin)`(年份为首次创建年份);`packages/plugin-sdk`、`packages/client`、`packages/shared` 用 `// SPDX-License-Identifier: Apache-2.0`(已定决策,见第 16 节)。各 `package.json` 写 `"author": "尹绪柏 (Theodore Yin) <x19169738916@163.com>"`。
6. **API 稳定性**:`/api/v1` 与 WebSocket 协议 v1 发布后只做向后兼容的增量修改;破坏性修改必须走 `/api/v2` 并写 ADR。
7. **不确定时**:选择更简单、更安全(默认拒绝/默认需审批)的方案,并在 PR 中列出待业主决定的问题。**不要推翻第 16 节「已定决策」**(如 1.0 只做企业微信+微信、单用户、不做付费签名、粒子球导航放 M10)。
8. **文档同步**:用户可见的变化同步更新文档站与 CHANGELOG;中英文都要更新(英文可先由模型翻译,标注待校对)。
9. **署名**:提交说明和 PR 里不加 `Co-Authored-By` 之类的 AI 署名;提交作者一律为 `尹绪柏 (Theodore Yin) <x19169738916@163.com>`(双许可要求作者对全部代码拥有再许可权)。
10. **仓库历史已重写(2026-11-10)**:开新会话前先同步到新的 `main`;不要从旧克隆推送 `main`、`docs/m3-wrapup`、`docs/memory-plan-tdam`。
11. **常用命令**:`pnpm dev`、`pnpm test`、`pnpm test:e2e`、`pnpm eval`、`pnpm build`、`pnpm --filter desktop tauri build`。

---

## 14. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 个人微信渠道政策变化 | 渠道不可用 | 只用官方 iLink/ClawBot;渠道可插拔,1.0 企业微信为主备,QQ 在 1.x 接入后作为第三选择 |
| Node SEA 非稳定 | 桌面打包失败 | 锁 Node 版本;备选附带 node 二进制方案 |
| Linux WebView 差异 | 桌面 UI 异常 | WebKit E2E;Electron 作为 Plan B |
| 本地 AI 能力弱于 Python | 离线语音/解析体验差 | API 优先 + 可选本地组件 + Python worker(MCP)|
| 提示注入导致误操作 | 数据泄露/误发邮件 | 不可信内容标记、外发必审批、专项评测 |
| 范围膨胀 | 1.0 迟迟不发 | 严格以 M5 为 1.0 边界(单用户、两个渠道、知识地图仅列表/树),其余进 Roadmap |
| 知识地图数据结构过早固化 | M10 粒子球需返工 API | 1.0 先用列表/树验证;M10 前复审 6.2 并写 ADR;API 只做向后兼容增量 |
| 未签名桌面安装包被系统拦截 | 用户安装受阻、信任度下降 | 清晰的安装说明 + 校验和/cosign;Docker/Web 为主要分发形态;日后视用户量购买证书 |
| 混入第三方 copyleft 代码或未签 CLA 的贡献 | 商业许可无法成立 | CI 许可证白名单 + CLA 必过检查;发现后移除/重写 |
| 依赖快速迭代(AI SDK 大版本)| 维护成本 | 自封 provider 接口;Renovate 分组升级 + 回放测试兜底 |
| 借鉴 GPL/AGPL 项目导致代码污染 | 商业许可无法成立 | 净室实现:只依据我们自己写的规格,不打开参考项目源码,不复制代码/SQL/提示词/测试数据;PR 模板勾选确认;许可证白名单 CI(ADR 0007 第 0 节)|

---

## 15. 许可证与商业授权(双许可:AGPL-3.0-only + 商业许可)

> 以下为工程与流程建议,不构成法律意见;正式对外签商业合同前建议请律师审阅 CLA 与商业许可协议。

### 15.1 决定(已定)
- **版权持有人**:**尹绪柏 (Theodore Yin)**;版权行统一写 `Copyright (C) 2026 尹绪柏 (Theodore Yin)`。
- **社区版**:GNU Affero General Public License v3.0,**`AGPL-3.0-only`**(SPDX `AGPL-3.0-only`,不用 `-or-later`)。
  - 理由:双许可模式下作者需要对许可条款完全可控;`-only` 避免将来 FSF 发布新版本后条款自动扩展到本项目。
- **商业版**:作者(版权持有人)另行签发的商业许可;联系邮箱 **x19169738916@163.com**,允许闭源修改、内嵌进专有产品、以 SaaS 形式提供而不公开源码等。
- **性质**:AGPL-3.0 是 **OSI 认证的开源许可**,也是 FSF 认可的自由软件许可,README 中可以正当地称「开源」。
- **网络使用条款(AGPL §13)**:任何人修改本项目后通过网络向他人提供服务,必须向这些用户提供其修改版的完整源码。这正是防止「拿去闭源做 SaaS」的关键;想规避该义务的商业用户需购买商业许可。
- 注意:AGPL **不禁止**商业使用——个人或公司遵守 AGPL(开放修改源码)即可商用。业主的诉求「未经授权不得闭源商用」由「AGPL 义务 + 商业许可」组合实现。

### 15.2 让双许可成立的前提:作者必须对全部代码拥有再许可权
1. **贡献者协议(已定:CLA)**:采用 **CLA**(版权许可式,而非版权转让),通过 CLA Assistant(GitHub App)在 PR 上自动要求签署。CLA 需明确授予作者「以任何许可(包括专有/商业许可)再许可贡献」的权利,以及专利许可。
   - **仅用 DCO 不够**:DCO 只证明贡献者有权按项目许可(AGPL)提交,并不授予作者以商业许可再许可的权利。因此本项目不采用 DCO 方案,**所有外部贡献者必须签 CLA**,CLA 授予尹绪柏 (Theodore Yin) 以商业许可再许可的权利。
2. **第三方依赖只用宽松许可**:MIT/BSD/ISC/Apache-2.0/0BSD/Unlicense/MPL-2.0(未修改的库)。禁止 GPL/LGPL/AGPL/SSPL 等第三方 copyleft 代码进入核心,否则商业版无法合法发布。CI 用 license-checker 白名单强制。
3. **不复制来源不明的代码**(包括未注明许可的网上片段);由 AI 生成的代码按项目许可提交,PR 中声明。
4. **商标**:「FatCat-AI」名称与 Logo 不随 AGPL 授权;在 TRADEMARKS.md 中说明 fork 需改名,防止他人以同名提供商业服务。

### 15.3 SPDX 头(所有源文件)
```ts
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
```
SDK 包(`packages/plugin-sdk`、`packages/client`、`packages/shared`):
```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 尹绪柏 (Theodore Yin)
```
文件头模板见 `templates/FILE-HEADER.txt`。外部贡献者的版权由 CLA 覆盖,无需在文件头逐一列名(可记录于 git 历史/AUTHORS)。Rust(Tauri)用 `//`,YAML/Shell/Python 用 `#`,CSS 用 `/* */`。`package.json` 写 `"license": "AGPL-3.0-only"`(SDK 包 `"Apache-2.0"`)与 `"author": "尹绪柏 (Theodore Yin) <x19169738916@163.com>"`;`Cargo.toml` 写 `license = "AGPL-3.0-only"`。CI 用 `reuse lint`(REUSE 规范)或自写脚本检查每个文件的 SPDX 头。

### 15.4 AGPL §13 的工程落实
- Web UI 页脚与「关于」页显示「源代码」链接;配置项 `server.sourceUrl` 默认指向官方仓库对应版本 tag,文档提醒修改部署者改为自己的修改版源码地址。
- `GET /api/v1/meta` 返回 `license` 与 `sourceUrl`,IM 渠道发送 `/source` 指令时回复源码地址;桌面/移动客户端「关于」页同样展示。
- 发布的 Docker 镜像带 OCI 标签 `org.opencontainers.image.licenses=AGPL-3.0-only` 与 `org.opencontainers.image.source`。

### 15.5 SDK 与插件的许可(已定)
- `packages/plugin-sdk`(插件 SDK)、`packages/client`(API 客户端 SDK):**Apache-2.0**;两者依赖的 `packages/shared`(协议类型/schema)同样用 **Apache-2.0**,否则 SDK 会被 AGPL 传染。理由:让第三方插件作者和未来的移动/桌面客户端开发者不被 AGPL 传染,扩大生态;核心与 Web UI 仍为 AGPL-3.0-only。
- 通过 MCP(独立进程、stdio/HTTP 通信)接入的插件一般视为独立作品,可用任意许可;文档中写清这一立场。
- 插件市场索引中注明每个插件的许可证。

### 15.6 README 措辞(中文/英文)
```md
## 许可证

FatCat-AI 采用双许可:

- **开源版**:[GNU AGPL-3.0](LICENSE)(`AGPL-3.0-only`)。你可以自由使用、修改和分发,包括商业用途,但如果你分发修改版或**通过网络向他人提供修改版服务**,必须以 AGPL-3.0 公开相应的完整源代码。
- **商业许可**:如果你希望在闭源产品或服务中使用、内嵌或修改 FatCat-AI 而不承担 AGPL 的开源义务,请参阅 [COMMERCIAL.md](COMMERCIAL.md) 联系作者获取商业许可。

插件 SDK(`@fatcat-ai/plugin-sdk`)与客户端 SDK(`@fatcat-ai/client`)以 [Apache-2.0](packages/plugin-sdk/LICENSE) 发布。

贡献代码前需签署 [CLA](CLA.md)(PR 中会自动提示)。「FatCat-AI」名称与 Logo 为作者商标,见 [TRADEMARKS.md](TRADEMARKS.md)。商业许可联系:x19169738916@163.com。

Copyright (C) 2026 尹绪柏 (Theodore Yin)
```
```md
## License

FatCat-AI is dual-licensed:

- **Open source**: [GNU AGPL-3.0](LICENSE) (`AGPL-3.0-only`). You may use, modify and distribute it, including commercially, but if you distribute a modified version or **make a modified version available to users over a network**, you must release the complete corresponding source under the AGPL-3.0.
- **Commercial license**: to use, embed or modify FatCat-AI in closed-source products or services without AGPL obligations, see [COMMERCIAL.md](COMMERCIAL.md).

The plugin SDK (`@fatcat-ai/plugin-sdk`) and client SDK (`@fatcat-ai/client`) are released under [Apache-2.0](packages/plugin-sdk/LICENSE).

Contributions require signing the [CLA](CLA.md) (prompted automatically on your PR). The "FatCat-AI" name and logo are trademarks of the author; see [TRADEMARKS.md](TRADEMARKS.md). Commercial licensing: x19169738916@163.com.

Copyright (C) 2026 尹绪柏 (Theodore Yin)
```

### 15.7 COMMERCIAL.md 模板(已填写,同 `templates/COMMERCIAL.md`)
```md
# FatCat-AI 商业许可 / Commercial License

FatCat-AI 社区版以 GNU AGPL-3.0-only 发布。如果你的使用方式无法或不愿遵守 AGPL-3.0,
可以向版权持有人购买商业许可。

## 什么时候需要商业许可?
- 将 FatCat-AI(或其修改版)内嵌到**闭源**软件、硬件或 App 中分发;
- 以 SaaS / 托管服务形式向第三方提供**修改版**,且不希望公开修改后的源码;
- 公司政策不允许使用 AGPL 软件;
- 需要商业支持、SLA、定制开发或品牌授权(使用「FatCat-AI」名称)。

不需要商业许可的情况:个人或公司内部使用未修改版本,或遵守 AGPL-3.0(公开修改源码)的任何使用,包括商业用途。

## 商业许可通常包括
- 免除 AGPL-3.0 的源码公开义务(仅限授权范围);
- 授权范围:产品/部署数量、用户数或年营收档位、地域、期限;
- 可选:技术支持、安全更新优先通知、定制功能;
- 专利与责任条款按合同约定。

## 如何申请
请发送邮件至 **x19169738916@163.com**,标题「FatCat-AI Commercial License」,并提供:
1. 公司/个人名称、国家/地区、联系人;
2. 使用场景(内嵌产品 / SaaS / 内部系统等)与预计规模(用户数、部署数);
3. 是否修改源码、是否需要支持服务;
4. 期望的授权期限与开始时间。

我们一般会在 5 个工作日内回复报价与协议草案。商业许可以双方签署的书面协议为准;
在签署之前,你对 FatCat-AI 的使用仍受 AGPL-3.0 约束。

Copyright (C) 2026 尹绪柏 (Theodore Yin). All rights reserved for commercial licensing.
```

### 15.8 CLA 要点(CLA.md 起草提纲)
建议以 Apache ICLA 或 Contributor Agreements(Harmony / contributoragreements.org)生成器的「许可式 + 允许外向再许可」选项为蓝本,包含:
1. 定义:「你」「贡献」「作者/项目维护者」= **尹绪柏 (Theodore Yin)**(联系邮箱 x19169738916@163.com,CLA 问题与企业 CCLA 签署亦发此邮箱)。
2. **版权许可**:永久、全球、非独占、免费、不可撤销地授权作者复制、修改、公开展示、分发贡献,并**以任何许可条款(包括 AGPL-3.0 以及专有/商业许可)再许可**。
3. **专利许可**:就贡献所必然涉及的专利授予许可(与 Apache ICLA 第 3 条类似,含防御终止条款)。
4. 陈述与保证:贡献为原创或有权提交;如受雇,已获雇主许可(或需签企业 CCLA)。
5. 作者承诺(可选,增加社区信任):贡献在社区版中始终以 OSI 认证开源许可提供。
6. 签署方式:CLA Assistant 在 PR 评论中回复「I have read the CLA Document and I hereby sign the CLA」;签署记录保存在专用仓库/Gist。
7. 公司贡献者使用企业 CLA(CCLA)。

### 15.9 许可证落地清单(M0 完成,之后每次发布复核)
- [ ] `LICENSE`:AGPL-3.0 官方全文,原样未改(许可证正文不得修改,版权行放在 NOTICE 与文件头)。
- [ ] `NOTICE`:`Copyright (C) 2026 尹绪柏 (Theodore Yin)` + 「本项目双许可,商业许可见 COMMERCIAL.md」(模板 `templates/NOTICE`)。
- [ ] `COMMERCIAL.md`:按 15.7(`templates/COMMERCIAL.md`),邮箱 x19169738916@163.com,无占位符残留。
- [ ] `SECURITY.md`:漏洞报告联系 x19169738916@163.com(模板 `templates/SECURITY.md`)。
- [ ] `CLA.md`(+ 企业 CCLA),CLA Assistant 已启用并设为 PR 必过检查。
- [ ] `CONTRIBUTING.md`:说明 CLA、提交规范、依赖许可证白名单。
- [ ] `TRADEMARKS.md`:名称与 Logo 使用规则。
- [ ] 所有源文件 SPDX 头 `AGPL-3.0-only` + `Copyright (C) 2026 尹绪柏 (Theodore Yin)`;`plugin-sdk`、`client`、`shared` 为 `Apache-2.0`;`reuse lint` / CI 检查通过。
- [ ] 各 `package.json` / `Cargo.toml` 的 `license` 与 `author`(`尹绪柏 (Theodore Yin) <x19169738916@163.com>`)字段正确;SDK 包的 Apache-2.0 LICENSE 文件单独放置。
- [ ] CI 检查仓库中无 `<作者名>`、`<商务邮箱>`、`<N>` 等占位符残留。
- [ ] license-checker 白名单(禁止第三方 copyleft)在 CI 中强制。
- [ ] Web UI 页脚/关于页「源代码」链接、`/api/v1/meta` 的 `license`/`sourceUrl`、IM `/source` 指令(AGPL §13)。
- [ ] Docker 镜像 OCI 许可证与源码标签;发布产物附 SBOM(含依赖许可证)。
- [ ] README 中英文许可证段落(15.6)。
- [ ] 第一个外部 PR 合并前确认 CLA 流程跑通;此前作者自己的提交无需 CLA。
- [ ] (签第一份商业合同前)请律师审阅 CLA 与商业许可协议模板。

## 16. 已定决策(业主 2026-11-03 确认)

| # | 事项 | 决定 | 影响章节 |
|---|---|---|---|
| 1 | 许可证 | **`AGPL-3.0-only`**(SPDX `AGPL-3.0-only`)+ 商业许可双许可;外部贡献者必须签 **CLA**(允许作者以商业许可再许可),不用 DCO | 0、15 |
| 2 | SDK 许可 | 插件 SDK(`plugin-sdk`)与客户端 SDK(`client`)用 **Apache-2.0**;其依赖的 `shared` 协议包同为 Apache-2.0 | 5、13、15.5 |
| 3 | 1.0 渠道 | **只做企业微信 + 微信**(iLink/ClawBot);**QQ 之后再做**(1.x 优先 / M12) | 2、8 M5、9 M12 |
| 4 | 用户模型 | **1.0 仅单用户**(一个主人账户);**多用户移到 2.0**(M12),表结构预留 `ownerId` | 1.3、6.1、8 M1、9 M12 |
| 5 | 代码签名 | **暂不购买** macOS(Apple Developer ID/公证)与 Windows 付费代码签名;用校验和 + cosign + 安装说明替代;Tauri updater 签名照常 | 9 M10、14 |
| 6 | 仓库名 | **FatCat-AI**(`github.com/<owner>/FatCat-AI`);npm scope `@fatcat-ai/*` | 5 |
| 7 | 作者 / 版权 | **尹绪柏 (Theodore Yin)**;统一写 `Copyright (C) 2026 尹绪柏 (Theodore Yin)`(NOTICE、README、COMMERCIAL.md、CLA、package.json `author`、文件头) | 13、15 |
| 8 | 商业许可联系邮箱 | **x19169738916@163.com**(同时用于 SECURITY.md 漏洞报告与 CLA 联系) | 15.6–15.9 |
| 9 | 新功能:知识地图 | 粒子球兼作**钻取式层级导航**:粒子 = 顶层类别(邮件、小说、人物、视频数据……),点击展开子类别,递归到最深内容条目(打开或问 AI)。数据层 = 统一条目表 `items` + 父子关系表 `item_edges` + 纯 REST 查询 API(`children`/`ancestors`/`counts`/`subtree` 等)。**v1.0 交付列表/树形分类浏览器**(同一 API);**粒子球导航在 M10(桌面)实现**,待数据结构稳定后 | 2、4.1.1、6.2、8 M2/M3/M5、9 M10 |

仍待定(不阻塞开发,Claude Code 使用默认值即可):
- 文档站域名:默认 GitHub Pages,以后可挂自有域名子域。
- GitHub 组织/用户名(`<owner>`):由业主建仓时确定。

## 17. 交给 Claude Code 的首条提示词

> 业主在空目录(或新建的 `FatCat-AI` 仓库)中启动 Claude Code 后,原样粘贴以下内容。

```text
你是 FatCat-AI 项目的主力开发者。项目作者/版权持有人:尹绪柏 (Theodore Yin),联系邮箱 x19169738916@163.com。

1. 先完整阅读 docs/plan/FatCat-AI-开发计划.md(本计划,请先把它复制到该路径),尤其是第 6.2 节(知识地图数据模型)、第 13 节(工作约定)、第 15 节(许可证)和第 16 节(已定决策)。第 16 节的决策不得自行更改:
   - 许可证 AGPL-3.0-only + 商业许可,外部贡献需 CLA;plugin-sdk、client、shared 三个包为 Apache-2.0;
   - 1.0 只做企业微信 + 微信渠道(QQ 以后);1.0 仅单用户(表结构预留 ownerId);
   - 不做付费 macOS/Windows 代码签名;仓库名 FatCat-AI;
   - 知识地图:1.0 交付基于 /api/v1/items 的列表/树形分类浏览器,粒子球钻取导航放到 M10。
2. 执行 M0(第 8 节):
   - pnpm + Turborepo 单仓,按第 5 节目录建 apps/ 与 packages/(含 packages/items 空包);TS strict、ESLint flat、Prettier、Vitest;
   - apps/server(Hono,/healthz)、apps/web(Vite + React 空壳)、packages/shared;
   - 复制 templates/ 下的 LICENSE(AGPL 官方全文,不得修改)、NOTICE、COMMERCIAL.md、SECURITY.md,并按第 15 节编写 CLA.md(含企业 CCLA)、TRADEMARKS.md、CONTRIBUTING.md、README.md / README.en.md(许可证段落用 15.6);
   - 所有源文件使用 templates/FILE-HEADER.txt 中的文件头(SDK 包用 Apache-2.0 版本);所有 package.json 填 license 与 "author": "尹绪柏 (Theodore Yin) <x19169738916@163.com>";
   - CI:lint、typecheck、test、build、SPDX 头检查(reuse lint)、依赖许可证白名单、占位符残留检查;接入 CLA Assistant;Dockerfile(多阶段、非 root)与 docker-compose;
   - 写 CLAUDE.md / AGENTS.md(第 13 节内容)与 docs/adr/0001-tech-stack.md、0002-licensing.md、0003-item-index.md(知识地图数据模型,来自 6.2)。
3. 完成后对照 M0 验收标准与 15.9 清单逐条自检,输出:已完成项、未完成项及原因、需要业主决定的问题。然后停下等待我确认,再开始 M1。

工作方式:小步提交(Conventional Commits),每步先说明计划再动手;不确定时选更简单、更安全的方案并记录在 PR 描述中;不引入任何遥测或第三方 copyleft 依赖。
```

---

## 18. 计划调整记录

### 2026-11-10(业主决定,v7)
- 已完成:记忆召回超时(#42,原列在 M5)、记忆生成日志(#43,原列在 M6)、ADR 0007 记忆分层说明(#44)。
- 新增 M3.x 清理,在 M4 之前做。
- M4 加入图片交给多模态模型(先写网关契约 ADR)。
- M5 拆成 M5a(渠道)、M5b(知识地图浏览器、人物、TOTP、密钥加密、外连目标清单)、M5c(复核已有的 oasdiff 检查、补 CodeQL/Semgrep、部署、发布);`degraded` 标记的 ADR 放在 M5a 开头,先于实现;用户时区设置与渠道注入评测放进 M5a。
- 内存预算改为防退化(第 12 节):空闲上限 250 MiB、按渠道定增量、要能回落、CI 对比上一版本涨幅按 ADR 0018 > 10% 报警、> 20% 失败;内存预算 ADR 放进 M3.x,写清 20% 是失败还是报警以及何时删除 CI 里固定的 120 MiB 门禁,ADR 合并后再改 CI。
- 第 13 节加入署名与仓库历史两条规则。
- 第 16 节已定决策不变。
