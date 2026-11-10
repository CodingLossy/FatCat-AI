# ADR 0002 · 许可证:AGPL-3.0-only + 商业许可双许可,外部贡献签 CLA

- 状态:已采纳(业主 2026-11-03 确认,计划第 16 节决策 #1、#2、#7、#8)
- 日期:2026-11-03
- 来源:开发计划第 15 节

## 背景

业主希望项目开源,同时「未经授权不得闭源商用」,并保留出售商业许可的能力。

## 决定

1. **社区版**:GNU AGPL-3.0,SPDX `AGPL-3.0-only`(不用 `-or-later`,避免将来 FSF 新版本自动适用)。`LICENSE` 为官方全文,原样不改。
2. **商业版**:版权持有人 **尹绪柏 (Theodore Yin)** 另行签发的商业许可,联系 x19169738916@163.com(见 `COMMERCIAL.md`)。
3. **SDK 例外**:`packages/plugin-sdk`、`packages/client` 及其依赖的 `packages/shared` 使用 **Apache-2.0**,让第三方插件与客户端开发者不受 AGPL 约束。每个 SDK 包内单独放 Apache-2.0 `LICENSE`。
4. **贡献**:所有外部贡献者必须签 **CLA**(版权许可式,允许以任何许可、包括商业许可再许可,并含专有许可);公司贡献签企业 CCLA。**不采用 DCO**——DCO 不授予再许可权。通过 CLA Assistant(GitHub Action)在 PR 上强制,签名存于 `cla-signatures` 分支。
5. **依赖**:只允许宽松许可(MIT / BSD / ISC / Apache-2.0 / 0BSD / Unlicense 等;MPL-2.0 仅以未修改库形式使用)。禁止任何第三方 copyleft。
6. **商标**:「FatCat-AI」名称与 Logo 不随 AGPL 授权,fork 须改名(`TRADEMARKS.md`)。
7. **AGPL §13**:`GET /api/v1/meta` 返回 `license` 与 `sourceUrl`;Web UI 页脚显示源码链接;Docker 镜像带 OCI `licenses` / `source` 标签。`sourceUrl` 由 `FATCAT_AI_SOURCE_URL` 配置,修改版部署者须改为自己的源码地址。

## 工程落实

| 检查                              | 实现                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 源文件 SPDX 头与版权行            | `scripts/check-spdx.mjs`(SDK 目录必须为 Apache-2.0)+ `reuse lint`(`REUSE.toml` 覆盖 JSON / Markdown) |
| package.json `license` / `author` | `scripts/check-spdx.mjs`                                                                             |
| 依赖许可证白名单、遥测黑名单      | `scripts/check-licenses.mjs`(基于 `pnpm licenses list`)                                              |
| 模板占位符残留                    | `scripts/check-placeholders.mjs`                                                                     |
| CLA                               | `.github/workflows/cla.yml`,需在分支保护中设为必过                                                   |

## 后果

- 想闭源使用或以 SaaS 提供修改版的组织需要购买商业许可;遵守 AGPL 的商业使用不受限制。
- 双许可成立的前提是作者对全部代码有再许可权:CLA 与依赖白名单是硬性门禁,一旦发现违规代码须移除或重写。
- 本 ADR 不构成法律意见;签第一份商业合同前请律师审阅 `CLA.md` 与商业许可协议。
