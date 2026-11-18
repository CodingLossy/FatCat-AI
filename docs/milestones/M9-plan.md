# M9 方案 · 国际化与文档站

设计记录见 [ADR 0043](../adr/0043-i18n-and-docs-site.md)。

## 三个 PR

1. `feat/i18n-package`:把 `apps/web/src/i18n.ts` 迁入 `packages/i18n`,加消息格式化(变量 / plural / select)、`Intl` 日期数字、locale 解析、系统提示词按语言模板、`pnpm check:i18n`(字典一致 + 硬编码扫描,进 CI)、翻译贡献文档。
2. `feat/docs-site`:`apps/docs`(Starlight,中英,Pagefind 搜索)、`docs.yml` 部署工作流、快速开始 / 配置模型 / 安全 / FAQ。
3. `docs/docs-site-content`:渠道接入、插件开发指南、API 参考(OpenAPI 生成)、ADR 汇总、更新日志、`M9-self-check.md`。

## 待业主决定(已给推荐,不回就按推荐)

1. 不用 i18next,自写 ICU 子集(推荐:不增加依赖)。
2. 文档站部署到 GitHub Pages 默认地址,域名以后再配(推荐)。
3. 新增语言缺键时运行时回落 `en`,检查对非首发语言只告警(推荐)。

## 仅业主可做

启用仓库 Pages(Source: GitHub Actions);确认线上文档站与搜索;如需自定义域名配置 DNS。
