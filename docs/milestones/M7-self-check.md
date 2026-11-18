# M7 自检报告(插件与市场)

- 日期:2026-11-18
- 基线:`main` @ #73(升级与回退)合并后;本 PR(`docs/m7-wrapup`)只含文档与自检。
- 对照依据:ADR 0040 第 11 节验收标准。
- 方式:C 在云容器(Linux,Node 24)上跑 lint / typecheck / 受影响包测试,CI 含 Windows 路径安全作业与 CodeQL;Web 在真实浏览器里点过(截图在 `docs/pr-screenshots` 分支的 `pr-plugin-*` 目录)。**没有在 Windows / macOS 真机、真实网络与官方索引上验证**。

**结论**:ADR 0040 第 11 节的 PR 0–5 都已实现并合并;PR 6 里能离线完成的部分(开发指南、本自检)在本 PR,**还差三件需要业主操作或确认的事**(见第三节):在官方索引里上架一个 SDK 插件、把第三方 JS MCP 服务器打包成插件的实测、SDK 发布 `0.x` 到 npm。

## 一、验收对照

| PR  | 验收项(摘要)                                                                                                               | 结果                                      | 依据                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 0   | 任务工具集声明                                                                                                             | ✅                                        | ADR 0039 的测试                                                                                |
| 1   | 清单 schema 拒绝未知字段、越界值、`broad` 域名、`FATCAT_AI_` 密钥名、`dangerous` 工具、非 `free` 的 `licensing`            | ✅                                        | `packages/shared/src/plugin.test.ts`                                                           |
| 1   | 示例插件能被 MCP 客户端当普通服务器连接;SDK 为 Apache-2.0、暂不发布                                                        | ✅;npm 发布未做(按约定)                   | `packages/plugin-sdk/src/plugin.test.ts`、`examples/plugins/hello`                             |
| 2a  | 迁移前自动备份;空库与旧库都能迁移                                                                                          | ✅ CI                                     | `packages/storage/src/plugins.test.ts`                                                         |
| 2b  | 本地安装后可在对话中调用(经审批);卸载快照一致                                                                              | ✅                                        | `apps/server/src/plugins.test.ts`                                                              |
| 2b  | 越权用例被拦(读 `master.key`、数据库、他人数据、符号链接、子进程、内置模块、全局 `fetch`、未声明工具、`FATCAT_AI_*`)       | ✅ Linux 与 CI 的 Windows;❌ 真机与 macOS | `packages/tools/src/plugins/runtime.test.ts`(CI 的 Windows 作业跑 `packages/tools` 的全部测试) |
| 2b  | 日志与 `plugin_events` 不含密钥值                                                                                          | ✅                                        | `runtime.test.ts`                                                                              |
| 2c  | 全部界面在浏览器里点过;卸载对话框列出受影响任务;CLI 与 Web 一致                                                            | ✅ 浏览器;CLI 有单测                      | `apps/web/e2e/plugins.e2e.ts`、`apps/cli/src/commands/plugins.test.ts`                         |
| 3   | 未授权域名、私网地址、重定向到私网、超大响应、超配额、超大 `meta` 被拒并写 `denied`                                        | ✅                                        | `packages/tools/src/plugins/net-fetch.test.ts`、`apps/server/src/plugins.test.ts`              |
| 3   | 条目出现在知识地图且能打开、卸载后消失;模板建任务走确认卡;`sendsData` 不能预授权                                           | ✅                                        | `plugins.test.ts`、e2e                                                                         |
| 4   | 假索引能浏览并安装;两把公钥都接受;签名 / keyId / serial / 过期 / sha256 / 坏包 / 重定向都被拒且已装的不变;市场关闭不发请求 | ✅(测试密钥)                              | `apps/server/src/plugin-market.test.ts`、`packages/tools/src/plugins/{market,tar}.test.ts`     |
| 5   | 无新增权限直接升级;新增权限同意前旧版本继续运行;健康检查失败时数据与旧版本恢复;回退后可再次升级                            | ✅                                        | `apps/server/src/plugins.test.ts`「升级与回退」、e2e                                           |
| 6   | 从市场一键安装一个打包的 MCP 插件和一个 SDK 插件;卸载干净;越权调用被拦截                                                   | ❌ 需要官方索引里有包                     | 见第三节                                                                                       |

## 二、与方案的偏差

1. **同意发生在确认页里**,`upgrade-pending` 不落库(PR 5 的 ADR 注记)。
2. **事件种类没有新增**:`plugin_events.kind` 受 0018 的 CHECK 约束,升级回退与不兼容复用 `upgraded` / `upgrade-failed` / `stopped`,避免为此做表重建迁移。
3. **第三方市场没有做**:`plugins.markets` 的 config.yaml 读取器还不存在,`MarketService` 已按配置列表工作,默认只有官方一项。
4. **CLI 市场、升级、回退命令**:原先没有,已在 `feat/plugin-cli-market` 补上(`plugins market`、`install --market`、`install` 遇到更高版本即升级、`rollback`)。
5. **本地目录插件在没有操作系统网络隔离的平台上不能声明 `net`**(业主 2026-11-18 同意,PR 5)。
6. 校验和与签名只说明下载的是审核时的那个包,不说明它无害;界面与文档都这么写。

## 三、需要业主操作或确认的

- **官方索引上架**:`CodingLossy/fatcat-plugins` 现在是空的。需要在业主本机构建 `index.json`、用 `scripts/plugins/sign-index.mjs` 签名(私钥只在本机)、把 CI 检查拷进该仓库(见 `scripts/plugins/README.md`),并上架 `examples/plugins/hello` 的打包版本与一个由第三方 JS MCP 服务器打包的插件。这之后才能做 PR 6 的「从市场一键安装」验收。
- **SDK 发布**:`@fatcat-ai/plugin-sdk` 发布 `0.x` 到 npm,需要业主的 npm 账号与确认;C 不发布。
- **Windows / macOS 真机**(M7 待真机清单,汇总自 #69–#73):
  - Windows:市场列表、安装、已下架提示、市场开关;Clash fake-IP 开和关时下载索引和包的表现;升级与回退(进程被停止后复制与恢复数据目录时文件被占用的情况);本地插件声明 `net` 时被拒;核心升级后 `incompatible`。
  - macOS:`sandbox-exec` 隔离的真实检查。
  - 官方索引建好后:用真私钥签一份真实索引,客户端走真实网络完成浏览、安装、升级、回退、卸载。
- **后续**(不阻塞 M7 收尾):Linux 上 `unshare` 不拦路径形式的 Unix 套接字,是否改用挂载命名空间或 Landlock(业主 2026-11-18 的规则:不再打单点补丁);第三方市场的 config.yaml 读取器;CLI 命令。

## 四、本 PR 内容

- `docs/plugins/developing-plugins.md` 与 `developing-plugins.zh-CN.md`:插件开发指南(英文标注待校对)。
- 本自检报告与 CHANGELOG。

## 五、市场收尾(`fix/m7-market-wrapup`)带来的变化

- **静态扫描(`check-index.mjs`)**:原来按「引号里出现模块名」匹配,打包进来的 `@fatcat-ai/shared` 里普通的 `'net'` / `'tls'` 字符串让 hello 打包后被拒。现在只认真正加载模块的写法(`import` / `import()` / `require` / `__require` / `createRequire(…)(…)` / `getBuiltinModule`,含 `node:` 与 `/promises`);`process.binding`、`process.dlopen`、`eval`、`new Function` 检查不变。hello 打包后零命中(有测试)。范围与局限写在 `scripts/plugins/README.md` 与 ADR 0040 第 3.4 节。
- **打包脚本(`pack-plugin.mjs`)**:只用 Node 内置模块,输出逐字节可复现;链接、junction、`node_modules`、放不进 ustar 的长路径都报错;打包后用客户端同一套读取器、清单检查和静态扫描自检。hello 已在云容器上打成单文件并通过自检(esbuild 只作为示例打包器,不是仓库依赖)。
- **SDK 可发布**:`@fatcat-ai/shared`、`@fatcat-ai/plugin-sdk` 版本 0.1.0、`publishConfig.access: public`,`pnpm pack` 产物无 `workspace:*`。**只 pack,没有 publish**;业主步骤见 `docs/plugins/publishing-sdk.md`。
- **`sign-index.mjs`**:先解析参数;`--verify` 在 CI 里允许且只用内置公钥,拒绝 `--key` / `--key-id` / `--allow-unknown-key-id`;签名在 CI 里仍然拒绝。索引仓库工作流不再需要 `env -u`,加了前缀也能跑。**合并后业主要把索引仓库的 `FATCAT_AI_REF` 改到新的合并提交。**
- **#74 遗留**:开发指南的工具级别与 `runtime.ts` 的 `effectiveRisk()` 一致;补了 500 MiB 备份例外、`AIP_` 保留前缀;中英文逐段对齐;`protectionTable()` 里 `brokered-network` 与 `items-quota` 改为 `enforced` 并写明实际限制。
- **`server.lock`**:`exit` 里本来就同步释放(只删自己 pid 的锁);新增 Windows 的 `SIGBREAK`、关闭卡住时的超时强制退出、第二次信号立即释放并退出。真机上两次残留的根因没能在云容器里复现(见 PR 描述):最可能是 `node --watch` 的父进程在 Windows 上用 `TerminateProcess` 结束子进程,子进程的 `exit` 处理没机会运行;这种情况只能靠下次启动识别过期锁。

### Windows 真机结果(业主 2026-11-18 提供)

| 项                                 | 结果       |
| ---------------------------------- | ---------- |
| 平台实测脚本 W1                    | ✅ 33 / 33 |
| 升级时文件被占用后回滚             | ✅         |
| 健康检查失败后回滚                 | ✅         |
| 两种卸载(保留数据 / 删除数据)      | ✅         |
| 市场开关                           | ✅         |
| Clash fake-IP 开与关时下载索引和包 | ✅         |
| fake-IP 下插件直连                 | 未测       |

仍未验证:Windows 上用 `pack-plugin.mjs` 打包并通过索引 CI;业主改 `FATCAT_AI_REF` 后索引 CI 变绿;npm 真发布;从官方市场安装 hello 和第三方 MCP 插件;macOS `sandbox-exec`;`pnpm dev` 的 Ctrl+C 后锁文件(Windows 真机复测)。
