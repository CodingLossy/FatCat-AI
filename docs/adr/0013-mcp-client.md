# ADR 0013 · MCP 客户端(stdio)

- 状态:提议(M2 PR 7)
- 日期:2026-11-04
- 相关:ADR 0010(工具框架与审批,第 8 节 MCP 默认级别)、M2 方案 PR 7、问题 8 / 9

## 背景

M2 验收第 3 条:接入官方示例 MCP Server 后可用。M2 只做 stdio 传输,Streamable HTTP 客户端推迟(M2 方案第 7 节)。stdio 服务器是本机进程,是新的攻击面:命令只能由用户配置,工具默认需审批,输出一律不可信。

## 决定

### 1. 自己实现最小客户端,不引入 SDK

- M2 方案问题 9 同意了 `@modelcontextprotocol/sdk`,并允许「超出门禁就自己实现」。stdio 客户端只需要按行分隔的 JSON-RPC 2.0 与三个方法(`initialize`、`tools/list`、`tools/call`),约 200 行;SDK v1 会带进 express 等服务端依赖,v2 的 `@modelcontextprotocol/client` 也带 OAuth 与 SSE 依赖。自己实现后**没有新的运行时依赖**。
- 实现位于 `packages/tools/src/mcp/`,以单独的入口 `@fatcat-ai/tools/mcp` 导出。服务器只在至少有一个服务器要连接时才 `import()` 这个入口,没有配置服务器时空闲内存不变。
- 协议版本发 `2025-06-18`;服务器回答它支持的版本,我们不拒绝(只用到三个方法,各版本一致)。服务器发来的请求(sampling、elicitation 等)一律回答「方法不存在」,通知忽略,stdout 上不是 JSON 的行忽略。
- 单条消息上限 4 MB,超出时断开;每个请求超时 30 秒。
- 集成测试使用官方示例 `@modelcontextprotocol/server-filesystem`(devDependency,不联网)。它的 `package.json` 写的是 `SEE LICENSE IN LICENSE`,仓库许可证为 MIT 与 Apache-2.0(许可证迁移期,都是白名单内的宽松许可),在 `scripts/check-licenses.mjs` 中按人工核对的例外登记。另有一个手写的假服务器覆盖翻页、超时、进程退出等情况。

### 2. 配置(只能由用户经 API / UI 增删改)

表 `mcp_servers`(迁移 0004):

| 字段              | 说明                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `name`            | `[a-z0-9_-]{1,32}`,每个 owner 唯一,创建后不可改(工具名与预授权都依赖它) |
| `command`         | 可执行文件;以 `shell: false` 启动                                       |
| `args_json`       | 参数数组,原样传给进程,不做 shell 解析                                   |
| `cwd`             | 可选,必须是绝对路径                                                     |
| `env_names_json`  | 允许传给子进程的环境变量**名字**;值从服务器自己的进程环境读取,从不保存  |
| `enabled`         | 停用后进程退出、工具注销                                                |
| `tool_risks_json` | 按工具覆盖级别,例如 `{ "read_text_file": "read" }`                      |

- 没有对应的 Agent 工具,模型不能新增、修改或启动服务器。
- **环境变量**:子进程只拿到运行程序所需的少数变量(`PATH`、`HOME`、`TEMP`、`SYSTEMROOT` 等)加上用户列出的名字。`FATCAT_AI_*`(以及改名前的 `AIP_*`,ADR 0019)永远不传,即使用户列出(API 返回 400,客户端再过滤一次)。需要 API Key 的服务器可以让部署者把密钥放进服务器进程的环境,再在这里列出名字;数据库和日志里只有名字。
- 删除服务器时,`mcp.<name>.` 开头的预授权一并删除,并按 `preauth-revoked` 审计(ADR 0010 第 3 节)。与授权目录一样,配置变更本身不写审计;日志只记服务器名,不记命令参数。

### 3. 生命周期

- 启动时连接所有已启用的服务器;新增、修改(启用 / 停用、级别)后在后台重新连接。每个服务器一个子进程,握手后按 `nextCursor` 翻页列出工具(最多 50 页)。
- 失败时状态为 `error`,附错误摘要与 stderr 末尾(最多 500 字符,只在 API 中返回,不写日志),不自动重试;用户修改配置即可重试。
- 进程退出或连接断开时,工具注销,状态变为 `disconnected`(握手阶段则为 `error`)。
- 服务关闭时关闭所有子进程。
- 状态(`connecting` / `connected` / `disconnected` / `error` / `disabled`)与已注册的工具名只在内存中,由 `GET /mcp/servers` 与 `GET /mcp/servers/{id}/status` 返回。

### 4. 工具注册

- 名称为 `mcp.<server>.<tool>`;工具名中 `[A-Za-z0-9_-]` 以外的字符换成 `_`,超过 64 字符的工具跳过。与已有工具重名的跳过。
- `parameters` 取服务器的 `inputSchema`(缺失时为 `{ type: 'object' }`);描述截断到 1,024 字符并注明来自哪个服务器。描述来自服务器,模型可以看到,这是 MCP 的固有风险;防线仍是审批。
- 级别:`tool_risks[tool]`,没有时一律为 `write`;服务器声明的 `readOnlyHint` 等注解忽略(ADR 0010 第 8 节)。`dangerous` 按 ADR 0010 默认禁用。
- 不支持参数约束,只能整体预授权(`write` 可以,`external` / `dangerous` 不能)。
- `untrustedOutput: true`:执行后本次运行的条件预授权失效。
- 执行时核对调用者的 `ownerId` 与服务器所属 owner 一致,不一致时按拒绝处理并审计(`ToolDeniedError`)。

### 5. 输出

- 结果包成 `UntrustedContent`,`source = { kind: 'mcp', ref: 'mcp.<server>.<tool>' }`。
- `text` 内容按顺序拼接;图片、音频、资源等只写一行占位说明(M2 不把二进制交给模型);只有 `structuredContent` 时输出它的 JSON。
- 总长度上限 64,000 字符,超出时截断并设 `truncated: true`。
- `isError: true` 的结果同样包成不可信内容,正文前加一行 `[The MCP tool reported an error]`,不作为异常抛出,以免错误文本绕过不可信包装。

### 6. API(`/api/v1` 增量修改)

| 端点                           | 说明                                     |
| ------------------------------ | ---------------------------------------- |
| `GET /mcp/servers`             | 列表,含连接状态与已注册的工具名          |
| `POST /mcp/servers`            | 新增并在后台连接;同名返回 409            |
| `PATCH /mcp/servers/{id}`      | 修改 `enabled` 与 `toolRisks`,并重新连接 |
| `DELETE /mcp/servers/{id}`     | 删除,关闭进程,删除相关预授权             |
| `GET /mcp/servers/{id}/status` | 连接状态                                 |

全部需要登录,修改类请求需要 CSRF。工具照常出现在 `GET /tools` 中,`source = 'mcp'`。Web 设置页可以添加、启用 / 停用、删除服务器;按工具设置级别在 M2 只通过 API。

## 后果

- 没有新增运行时依赖;配置了服务器后只多加载约 200 行自己的代码。子进程的内存不计入本服务;CI 的空闲 RSS 门禁测的是未配置服务器的情况。
- 自己维护协议实现:MCP 规范以后如果改变 stdio 的握手或 `tools/*`,需要跟进。用官方示例服务器做集成测试来发现这种变化。
- 推迟:Streamable HTTP 传输、`resources` / `prompts`、`tools/list_changed` 通知后的自动刷新(M2 用停用再启用代替)、Web 上按工具设置级别、修改命令与参数(M2 需删除后重建)。
