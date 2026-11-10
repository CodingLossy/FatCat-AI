# M2a 自检报告(块 A + B,PR 1–9)

- 日期:2026-11-04
- 基线:`main` @ `0805de4`(M2 方案 PR 1–9 均已合并,对应 GitHub PR #15–#20、#24–#26)
- 对照依据:开发计划第 8 节 M2 验收;`docs/milestones/M2-plan.md` 第 2 节各 PR 验收、第 3 节验收对照、第 7 节推迟项
- 范围:只核对 M2a 负责的项;记忆 v2(验收 ①–⑦)属于 M2b(PR 10–15),不在本报告内
- 方式:以 CI 中运行的自动测试为依据,不重复手工验证

**结论**:M2a 负责的 5 条计划验收**全部通过**。第 3 节中与 M2a 有关的门禁里,对话峰值内存没有测量(按方案放在 PR 15)。计划条目中有 4 处没有做完,都是经业主同意的推迟或待定项,见第三节。

## 一、计划 M2 验收(第 3 节中由 PR 1–9 满足的行)

| 验收项                                        | 结果    | 依据                                                                                                                                                                                                                             |
| --------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「总结某 PDF 并另存为 md」一次审批完成        | ✅ 通过 | `apps/server/src/fs.test.ts`「验收:总结 PDF 并另存为 md 只需一次审批」:`fs.read` 解析 PDF 不需要审批,`fs.write` 写 md 审批一次                                                                                                   |
| 越权路径被拒绝且有审计记录                    | ✅ 通过 | `apps/server/src/fs.test.ts` 越权读取与写入被拒绝并按 `denied` 审计;`items.content` 越权返回 403 并审计(`items.test.ts`)。另有越权用例:未登录或缺少 CSRF 不能审批、配置 MCP 服务器或重建向量索引;`dangerous` 工具被拒绝并审计    |
| 接入官方示例 MCP Server 可用                  | ✅ 通过 | `packages/tools/src/mcp.test.ts` 用 devDependency `@modelcontextprotocol/server-filesystem` 启动官方示例服务器(不联网),工具注册为 `mcp.files.*`,默认需审批,`read_text_file` 读到文件,输出标为不可信;Linux 与 Windows CI 都运行   |
| 路径逃逸测试用例全部通过                      | ✅ 通过 | `packages/tools/src/fs.test.ts` 覆盖符号链接 / junction 逃逸、8.3 短名、备用数据流、设备名、UNC 与 `\\?\`、结尾的点与空格、盘符大小写;CI 的 `Windows path security (tools)` 任务在 Windows 上实际运行                            |
| 小说文件夹可逐层下钻并打开,计数与递归计算一致 | ✅ 通过 | `packages/items/src/items.test.ts`「授权含小说的文件夹后,小说 → 书 → 章逐层下钻并打开」;`packages/storage/src/items.test.ts` 属性测试:随机新建 / 移动 / 软删除 / 恢复后计数与递归计算一致、树无环                                |
| 记忆 ⑧ 中的许可证白名单 CI                    | ✅ 通过 | `pnpm check:licenses` 每个 PR 运行。两处 `package.json` 许可证字段不规范的包已人工核对并登记例外:`@modelcontextprotocol/server-filesystem`(仅开发依赖,MIT / Apache-2.0)、`sqlite-vec`(MIT / Apache-2.0)。净室勾选从 PR 10 起适用 |
| 容器空闲 RSS 门禁(120 MiB)                    | ✅ 通过 | CI `docker image` 任务每个 PR 断言;M2a 各 PR 实测 101 MiB(M1 末为 95 MiB)。新增的重依赖都按需加载:PDF 解析在 worker 中;MCP 客户端只在配置了服务器时导入;sqlite-vec 只在有 embed 配置档或已有向量表时加载(镜像中加载约 +3 MiB)    |
| 对话峰值 < 400 MB                             | ⏳ 未测 | 按方案放在 PR 15(M2b 收尾)测量;CI 容器中没有可调用的模型端点                                                                                                                                                                     |

## 二、各 PR 的专项验收

PR 1–9 的验收(M2 方案第 2 节)都有对应的自动测试,CI 全部通过,这里不逐条重复。值得单独列出的几项:

- **SSRF**(PR 3):直接 IP、DNS 解析到内网、DNS 重绑定、跳转到内网都被拒绝(`packages/tools/src/builtin.test.ts`)。
- **网页注入评测**(PR 3):网页中要求调用 `memory.save` 的指令不会触发写入(`apps/server/src/tools.test.ts`)。
- **重启后待审批请求过期**、**预授权撤销后恢复审批**、**`dangerous` 工具被拒绝并审计**(PR 2):`packages/storage/src/tools.test.ts`、`apps/server/src/tools.test.ts`、`packages/agent/src/tools.test.ts`。
- **嵌入**(PR 8):没有 embed 配置档时不加载 sqlite-vec;条目硬删除时向量由外键与触发器级联清理;换维度或换模型时提示手动重建,重建后检索正常(`packages/storage/src/embeddings.test.ts`、`apps/server/src/embeddings.test.ts`)。
- **知识库**(PR 9):回放评测「这份 PDF 里关于退款的说法」引用到 `handbook.pdf` 第 2 页;删除文件后分块与向量被清理(`apps/server/src/kb.test.ts`)。
- **覆盖率门禁**(PR 2,问题 13):6 个核心包(agent、items、memory、providers、storage、tools)的行与语句覆盖率 ≥ 80%,在 CI 中强制;`apps/server` 没有设门槛。
- **OpenAPI 破坏性变更检测**(PR 1):oasdiff 在 CI 中比较基线分支,M2a 的所有 API 修改都是增量的。

## 三、计划条目中没有做完的部分

都是业主已同意的推迟(M2 方案第 6、7 节),不影响 M2a 的验收。

| 计划条目(开发计划第 8 节 M2) | 状态                                                     | 去向                 |
| ---------------------------- | -------------------------------------------------------- | -------------------- |
| 文档解析:图片交给多模态模型  | 未做:需要把 `ChatMessage.content` 改成多段内容(网关契约) | M2.x 或 M4(问题 10)  |
| 本地知识库:引用来源可点击    | 只显示文件名与页码                                       | M2 后续改善(第 7 节) |
| MCP 客户端:Streamable HTTP   | 只做了 stdio                                             | M2 后续改善(第 7 节) |
| 内置工具:可选的 `web.search` | 未做(计划标为可选)                                       | 以后单独决定         |

另有几项实现方式与方案写法不同,已在各自的 PR 中说明并由业主合并:

- MCP 客户端为自己实现的约 200 行 stdio 客户端,没有引入 `@modelcontextprotocol/sdk`(ADR 0013)。
- DOCX / XLSX 解析为自写的 ZIP 读取器加 XML 提取,没有用 `mammoth` / `exceljs`(PR 5)。
- 每日嵌入上限固定为 5,000 条,不放进设置;不加「默认 embed 配置档」设置项(业主 2026-11-04 决定)。

## 四、进入 M2b 前需要业主确认的事项

1. 本报告的结论是否接受,M2a 是否可以收尾。
2. 两个仍然开放的小问题(来自 PR #26):知识库是否要按文件夹选择;纯文本只读前 256 KB 是否够用。没有答复时,M2b 按现状继续。
