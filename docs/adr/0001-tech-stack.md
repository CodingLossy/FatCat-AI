# ADR 0001 · 技术栈:TypeScript 单仓 + Hono 核心 + React Web UI(+ Tauri v2 桌面壳)

- 状态:已采纳
- 日期:2026-11-03
- 来源:开发计划第 3 节

## 背景

AI-Personal 需要同时满足:可在 2GB 内存服务器常驻、桌面安装包轻量、插件生态覆盖面大、前后端类型共享,且主要由 AI 编码代理(Claude Code)开发。计划第 3 节比较了 TypeScript(Node)、Python、Java(Spring AI)三种方案。

## 决定

采用 **TypeScript 单仓(pnpm workspaces + Turborepo)**:

| 层          | 选型                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------ |
| 运行时      | Node.js 24 LTS 或更高(2026-11-05 起最低版本由 22.12 提高到 24:unpdf 需要 Node 24),ESM only |
| 语言 / 校验 | TypeScript strict + zod(schema 前后端共享)                                                 |
| HTTP / WS   | Hono(`@hono/node-server`)                                                                  |
| Web UI      | React 19 + Vite(后续加 TanStack Router/Query、Tailwind、shadcn/ui)                         |
| 存储(M1 起) | SQLite(better-sqlite3,手写参数化 SQL,见 ADR 0005)+ sqlite-vec                              |
| LLM(M1 起)  | 自有 `ModelProvider` 接口;OpenAI 兼容端点用 fetch 自写(见 ADR 0006)                        |
| MCP(M2 起)  | `@modelcontextprotocol/sdk`                                                                |
| 测试        | Vitest(之后加 Playwright、msw、录制回放)                                                   |
| 桌面(M10)   | Tauri v2 壳 + Node sidecar                                                                 |

## M0 中落地的具体取舍

- **TypeScript 6.0 而非 7.0**:7.0(原生实现)已发布,但 typescript-eslint 8.x 的 peer 依赖仍为 `<6.1.0`。等其支持 7.x 后再升级。
- **ESLint 10 flat config**(`eslint.config.js`)+ typescript-eslint recommended;React 相关包额外启用 react-hooks 规则。
- **Prettier**:4 空格缩进、120 列、单引号、LF;JSON / YAML / Markdown 用 2 空格。
- **包构建**:每个包用 `tsc` 输出到 `dist/`,`exports` 指向 `dist`;Turborepo 的 `build` / `typecheck` / `test` / `dev` 均依赖上游包先 `build`。
- **server 开发模式**:`node --watch --import tsx src/index.ts`。`tsx watch` 在 turbo 的子进程中无法启动,已弃用。
- **Docker**:`node:24-slim` 多阶段构建;build 阶段构建后执行 `pnpm install --prod --filter "@ai-personal/server..."` 只保留 server 的生产依赖(`pnpm deploy --legacy` 会跳过安装、产出空的 `node_modules`,已弃用)。运行时代码归 root 所有,以 `node` 用户运行,`--max-old-space-size=384`。
- **SQLite**(M1 起):每个连接打开后执行 `PRAGMA foreign_keys = ON`,使 ADR 0003 中的外键与 `ON DELETE CASCADE` 生效。
- 核心默认只监听 `127.0.0.1:8787`,Docker 内监听 `0.0.0.0`,compose 只映射到宿主机 `127.0.0.1`。

## 后果

- 一门语言贯穿核心、UI、插件 SDK 与类型定义,减少语言边界。
- 本地 AI 能力(本地语音、嵌入、复杂文档解析)弱于 Python:API 优先 + 可选本地组件 + 以 MCP Server 形式提供的可选 Python worker。
- Node SEA 尚非稳定特性:桌面打包时锁定 Node 版本,备选「附带 node 二进制 + bundle」。

## 备选方案

- Python 核心 + Tauri:AI 库最强,但前端仍需 TS(两种语言),PyInstaller sidecar 体积大、启动慢。
- Java(Spring AI 2.0):需捆绑 JRE(≥100MB),空闲内存 300–500MB,个人插件作者少。
