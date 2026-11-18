# M9 自检报告(国际化与文档站)

- 日期:2026-11-18
- 基线:`main` 上的 #82(方案与 ADR 0043)、#83(`feat/i18n-package`)、#84(`feat/docs-site`),加上本 PR(`docs/docs-site-content`)。
- 对照依据:[M9 方案](M9-plan.md)与 [ADR 0043](../adr/0043-i18n-and-docs-site.md)。
- 方式:C 在云容器(Linux,Node 22 本地、Node 24 在 CI)上跑 lint / typecheck / build / 受影响包测试;文档站在 Chromium 里点过(搜索、中英文切换),截图在 `docs/pr-screenshots` 分支的 `m9-docs-site/` 与 `m9-i18n/`。**没有在 Windows 上跑,没有部署到真实的 GitHub Pages。**

**结论**:方案里三个 PR 的内容都已实现,自动化可验的验收项都有用例。还差业主启用 Pages 后对线上站点与搜索的确认(第三节)。

## 一、验收对照

| 验收项(开发计划 M9)                                                                                | 结果               | 依据                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 界面文案全部抽到 `packages/i18n`,首发 zh-CN、en                                                    | ✅                 | `packages/i18n/src/locales/`;Web 只剩 React 上下文封装                                                                                               |
| 日期 / 数字本地化                                                                                  | ✅                 | `packages/i18n/src/dates.ts`;邮件页与审批倒计时改为跟随所选语言                                                                                      |
| 系统提示词按语言提供模板                                                                           | ✅(小范围)         | `prompts.ts` 提供「当前时间」「正在使用工具」两条,agent 已使用;更长的提示词模板在出现时再加                                                          |
| 贡献新语言的流程文档                                                                               | ✅                 | `docs/contributing/translations.md`(中英)                                                                                                            |
| 切换语言无硬编码中文 / 英文残留(CI 检查)                                                           | ✅                 | `pnpm check:i18n`(含反向用例 `check-i18n.test.mjs`)+ `locale.e2e.ts`(切到英文后逐页检查无中文,找出并修了邮箱预置与知识地图顶层分类两处残留)          |
| 字典键、占位符、语法一致                                                                           | ✅                 | `packages/i18n/src/i18n.test.ts`(`checkDictionaries`)                                                                                                |
| 文档站(Starlight,中英):快速开始、配置模型、渠道、插件开发、API 参考、安全、FAQ、ADR 汇总、更新日志 | ✅                 | `apps/docs`:快速开始 / 配置模型 / Docker 部署 / 接入微信 / 插件开发 / 安全 / FAQ 为手写或同步页,API 参考由 OpenAPI 生成,ADR 汇总与更新日志由脚本生成 |
| 文档站自动部署                                                                                     | ⚠️ 待业主启用      | `.github/workflows/docs.yml`:PR 构建并检查,合并到 `main` 后发布;需要业主在仓库设置里启用 Pages                                                       |
| 搜索可用                                                                                           | ✅ 本地;线上待确认 | `check-site.mjs` 检查 Pagefind 索引存在;浏览器里实测搜索「secrets」只返回当前语言的页面                                                              |
| 中英文页面一一对应、站内链接不失效                                                                 | ✅                 | `check-site.mjs`(CI 的 Docs 工作流)                                                                                                                  |

## 二、与 ADR 0043 不一致或没做的地方

- 字典一份一个文件,没有按功能拆开。
- 格式化器不做引号转义(现有字符串里有撇号)。
- 预置代理角色的名字是第一次使用时按当时语言写进数据库的,切换语言不会变(e2e 里排除)。要改成按语言显示需要改数据模型,留作后续。
- 英文文档大部分由模型翻译,待校对(沿用仓库既有做法)。
- ADR 汇总页只列标题和状态并链到 GitHub 原文,ADR 本身是中文,没有翻译。
- 站点没有使用 `sharp`(它的 libvips 是 LGPL,违反依赖许可白名单),图片服务设为原样输出;站点目前也没有需要处理的图片。

## 三、需要业主做或确认

1. 启用 Pages:仓库 Settings → Pages → Source: GitHub Actions。启用后重新运行 `Docs` 工作流的 `deploy` 任务(或下一次合并时自动运行)。
2. 打开 <https://codinglossy.github.io/FatCat-AI/>,确认中英文切换、搜索和侧边栏正常。
3. 如要自定义域名,在 Pages 设置里配置,并把 `apps/docs/astro.config.mjs` 的 `site` / `base` 改掉(写一条记录即可)。
4. 英文文档的校对(可以慢慢来)。
