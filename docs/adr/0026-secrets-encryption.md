# ADR 0026 · 密钥加密存储

- 状态:已采纳(M5b PR 3;实现在 PR 4 `feat/secrets-encryption`)
- 日期:2026-11-13
- 相关:ADR 0006(密钥引用)、ADR 0022 第 9 节(iLink 令牌写入)、ADR 0018(内存预算)、M5b 方案第 5 节问题 2–4、开发计划第 7 节

## 背景

模型配置档、邮件账户、渠道只保存 `env:` / `file:` 引用,`file:` 指向数据目录的 `secrets.yaml`,该文件是明文(权限 600)。备份、误分享或只拿到这一个文件的泄露会直接暴露全部密钥。微信 iLink 令牌也由服务器在扫码后写进这个文件(`apps/server/src/channels/wechat.ts`)。公网部署之前需要让这些密钥落盘时是密文。

## 决定

### 1. 范围与不防什么

- `secrets.yaml` 整体加密:模型密钥、iLink 令牌、将来各渠道的密钥。数据库里仍然只存引用;TOTP 的共享密钥(ADR 0027)用同一主密钥加密后再入库。`env:` 引用不变。
- 防:备份被拷走、误分享、只拿到 `secrets` 文件、只拿到数据库。
- **不防**:拿到整个数据目录(含 `master.key`)的人。文档建议公网部署把主密钥放在环境变量或容器 secret 里,不放数据目录。

### 2. 算法与信封

`node:crypto` 的 AES-256-GCM,不加依赖。整个文件序列化后作为一个明文整体加密。信封为 UTF-8 文本,便于备份与排查:

```
fcsec1:<base64url(nonce 12 字节)>:<base64url(密文)>:<base64url(认证标签 16 字节)>
```

- `fcsec1` 是版本号;未知版本拒绝读取。
- 每次写入生成新的随机 nonce(`crypto.randomBytes(12)`),不复用。
- 版本号与 nonce 作为附加认证数据(AAD)参与认证,篡改任何一段都解密失败。
- 认证失败的统一错误:「密钥不可用」(不区分「密钥错」与「文件被改」,不回显任何内容)。

### 3. 主密钥来源

32 字节随机密钥,按优先级取第一个存在的:

1. 环境变量 `FATCAT_MASTER_KEY`(base64 或 64 位十六进制);
2. 环境变量 `FATCAT_MASTER_KEY_FILE` 指向的文件(内容同上);
3. 数据目录里的 `master.key`:首次需要加密时自动生成,权限 600,Windows 上复用 `restrictToCurrentUser`。

- 来源 1、2 存在但格式不对时启动报错,不回退到 3(避免悄悄换了密钥)。
- 状态接口只返回来源枚举与**指纹**(主密钥 SHA-256 的前 8 位十六进制),不返回密钥。
- `master.key` 与主密钥环境变量不进日志、不进自动备份、不进仓库(`pnpm check:secrets` 扩展检查)。

### 4. 写入统一经 SecretStore

- 所有写 `secrets` 的路径只有 `SecretStore`(`packages/providers/src/secrets.ts`)。`ChannelSecrets` 不加写方法,适配器不能写密钥文件;iLink 令牌由 `wechat.ts` 调用 `SecretStore` 写入。
- 保持 ADR 0022 第 9 节的规则:先备份、只改目标键、解析失败不写。

### 5. 迁移(明文 → 加密)

只能显式触发:设置页按钮(`POST /api/v1/settings/secrets/migrate`,请求体必须 `confirm: true`)或命令 `node dist/index.js secrets migrate`(`apps/cli` 目前只是占位,命令放在服务器入口);启动时**不会**自动迁移。步骤依次为:

1. **备份**:把明文文件复制到 `backups/`(沿用 ADR 0022 的命名与保留规则)。
2. **加密写新文件**:写 `secrets.yaml.enc.tmp`,fsync 后改名为 `secrets.yaml.enc`。
3. **解密回读并逐键比对**:用主密钥重新解密新文件,与内存中的明文映射逐键比较(常数时间比较,值不进日志)。
4. **全部通过后才处理明文**:原 `secrets.yaml` 改名为 `secrets.yaml.migrated`,再按用户的选择处理(见下)。任一步失败:删除临时文件、保留明文原样、返回错误,可重复执行。

迁移界面显示已有明文备份的份数,请求体 `plaintextBackups` 取 `keep`(默认,不动)、`encrypt`(逐个加密为 `.enc` 并删除明文副本)、`delete`(删除)。删除需要界面上二次确认。`secrets.yaml.migrated` 在用户确认新文件可用后由设置页的「清理」按钮或命令删除;迁移本身不自动删它。

### 6. 备份

沿用 `backups/`、保留 5 份;迁移后备份内容为密文(信封原样复制)。主密钥不进备份:丢失主密钥等于丢失全部密钥(模型 key 重新填,iLink 令牌重新扫码)。设置页显示指纹方便核对。

### 7. 兼容与失败

- 明文 `secrets.yaml` 与加密 `secrets.yaml.enc` 同时存在(迁移未完成之外的情形)时,启动报错并说明处理办法,不猜。
- 主密钥缺失或与加密文件不匹配时,服务器照常启动;依赖密钥的功能(模型调用、邮件、渠道、TOTP 验证)报「密钥不可用」,不清空、不覆盖加密文件。`GET /settings/secrets` 的 `keyAvailable` 为 false。
- 文件状态 `file`:`none`(没有任何 secrets 文件)、`plaintext`、`encrypted`。

### 8. 轮换

命令 `node dist/index.js secrets rekey --new-key-file <path>`(离线,服务器停止时执行):用旧主密钥解密 → 备份 → 用新主密钥加密写新文件 → 回读比对 → 替换;TOTP 共享密钥(数据库内)同事务重加密。失败保留原状。命令不接受命令行参数形式的密钥(避免进 shell 历史)。

### 9. 接口(shared:`packages/shared/src/secrets.ts`)

| 端点                                    | 说明                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/v1/settings/secrets`          | `SecretsStatus`:`file`、`masterKeySource`、`keyAvailable`、`fingerprint`、`backups` |
| `POST /api/v1/settings/secrets/migrate` | `SecretsMigrateRequest` → `SecretsMigrateResponse`;需要登录与 CSRF                  |

两个端点只能由会话或个人访问令牌的主人调用;响应里没有任何密钥值。OpenAPI 中的路径声明随 PR 4 的路由一起加入(只增不改)。

## 后果

- 默认安装开箱即得到「备份与单文件泄露」的保护;代价是拿到整个数据目录仍可解密,文档写明。
- 新增两个文件(`secrets.yaml.enc`、`master.key`),数据目录布局文档与 `.gitignore`/`check:secrets` 同步更新。
- 无新增依赖,无数据库迁移。

## 实现 PR 的测试清单(PR 4)

- 信封加解密往返;篡改密文、标签、nonce、版本号各自失败;同一明文两次加密 nonce 不同。
- 主密钥来源优先级(环境变量 > 文件环境变量 > `master.key`);格式错误的环境变量启动报错而不回退。
- 迁移:回读比对失败时明文原样保留;写入失败(只读目录)明文原样保留;可重复执行;`keep`/`encrypt`/`delete` 三种备份处理。
- 写入只改目标键并先备份(保留 `secrets-write.test.ts` 已有用例);iLink 令牌写入走 `SecretStore`。
- 明文与密文同时存在启动报错;主密钥缺失时服务器启动、依赖功能报「密钥不可用」、文件不被改。
- **扫库测试**:建好模型配置档、邮件账户、渠道、MCP 服务器后遍历数据库全部文本列与加密文件,找不到测试用的明文 key 与令牌。
- **越权**:未登录访问 `GET/POST /settings/secrets*` 为 401;个人访问令牌可读状态但迁移需要 CSRF 之外的 `confirm: true`;响应体不含主密钥与密钥值;日志不含密钥(沿用 `Redactor` 用例)。
- 需要 Windows 实测:`master.key` 与加密文件的 ACL、备份写入、含中文或空格的数据目录。
