# ADR 0043 · 国际化包与文档站(M9)

- 状态:提议(M9 方案,待业主审阅)
- 日期:2026-11-18
- 来源:开发计划 M9;ADR 0009 第 2 节(界面字典当时留在 `apps/web/src/i18n.ts`,约定 M9 迁出)

## 背景

现状:`apps/web/src/i18n.ts` 约 1760 行,两份字典 `zh` / `en`,键一致由类型保证;`t(key, vars)` 只做 `{name}` 替换。`packages/i18n` 与 `apps/docs` 只有占位。42 个 tsx 文件含中文字面量(多数是测试断言与字典本身)。M9 验收:切换语言无硬编码残留(CI 检查);文档站自动部署、搜索可用。

## 决定

### 1. 不引入 i18next,用自写的小型 ICU 子集

计划写的是「i18next / ICU」。实际需求只有变量替换、复数和少量 select,日期与数字交给 `Intl`。为了不增加运行时依赖(AGENTS.md 第 4 条的精神、也不增加 Web 包体积),`packages/i18n` 自带约 100 行的消息格式化:

- `{name}` 变量;`{n, plural, one {…} other {…}}`(用 `Intl.PluralRules`);`{x, select, a {…} other {…}}`;`'{'` 转义。
- 不支持的语法在构建期测试中报错,不在运行时静默。
- 若以后需要更多 ICU 能力,换成 `intl-messageformat`(BSD-3)只改 `format.ts` 一个文件,字典格式不变。

**待业主决定**:是否仍要 i18next。推荐:不要(理由如上);按推荐做。

### 2. `packages/i18n` 的内容(Apache-2.0 还是 AGPL?)

保持 AGPL-3.0-only(包 `package.json` 已声明)。它不是 SDK,只被 Web / 服务器内部使用。

- `locales/zh-CN.ts`、`locales/en.ts`:字典,按功能分文件(`chat`、`settings`、`mail`、`tasks`、`plugins`、`agents` 等),合并导出;键仍由类型保证一致。
- `format.ts`:消息格式化;`dates.ts`:`formatDate` / `formatNumber` / `formatRelative`,一律基于 `Intl`,语言来自当前 locale。
- `locale.ts`:`resolveLocale(setting, navigatorLanguages)`(设置 > 浏览器 > `en`),`Locale` 类型与可用语言清单(新增语言只改这里和 `locales/`)。
- `prompts/`:系统提示词模板按语言提供(服务器取会话语言,缺失时回落 `en`)。

`apps/web/src/i18n.ts` 变成对该包的薄封装(`I18nContext`、`useI18n`),组件调用方式不变。

### 3. 硬编码文案检查(`pnpm check:i18n`,进 CI)

脚本 `scripts/check-i18n.mjs`:

1. 字典键集合一致、占位符(`{name}`)两边一致、ICU 子集语法可解析。
2. 扫描 `apps/web/src/**/*.tsx`(排除测试与 e2e):JSX 文本节点和 `placeholder` / `title` / `aria-label` / `alt` 属性中出现 CJK 字符,或出现整句英文(含空格的字母串)即失败;例外清单写在 `scripts/i18n-allowlist.json`(品牌名、`env:NAME` 之类),每条需注明理由。
3. 同样检查 `apps/server` 中面向用户的错误提示(`problem()` 的 `detail`):仍保持现状(API 错误码稳定、文案英文),不纳入翻译,检查脚本只确认 Web 通过错误码查字典(已有 `i18n-codes.test.ts`)。

### 4. 新增语言的流程

`docs/contributing/translations.md`(中英):复制 `en.ts` → 改 `Locale` 清单 → 跑 `pnpm check:i18n` → 在设置页选择验证。缺失的键运行时回落 `en`,检查脚本对「非首发语言」只告警不失败(首发 zh-CN / en 严格)。

### 5. 文档站(`apps/docs`)

- Astro + `@astrojs/starlight`(均 MIT);中英双语(`zh-cn` 为根、`en` 子路径),搜索用 Starlight 内置的 Pagefind(MIT,纯静态,无常驻服务)。
- 内容:快速开始(Docker / 桌面〔M10 前标注「即将提供」〕/ 源码)、配置模型(含国内兼容端点示例:DeepSeek、硅基流动等)、渠道接入、插件开发指南、安全说明、FAQ、ADR 汇总、更新日志。
- API 参考:由 `apps/server/openapi/v1.json` 构建时生成 Markdown 页面(自写脚本,不引入渲染依赖),CI 校验与规范同步。
- 现有 README / `docs/` 中已有的内容(部署、插件 SDK、渠道)搬入并以文档站为准,`docs/` 里只留指向。
- 部署:GitHub Pages(`.github/workflows/docs.yml`,合并到 `main` 时构建发布;PR 只构建不发布)。**待业主决定**:是否用 GitHub Pages、是否有自定义域名。推荐:先用 Pages 默认地址,域名以后再配;按推荐做。需要业主在仓库设置里启用 Pages(Settings → Pages → Source: GitHub Actions),C 不做。

### 6. 不做的事

不翻译服务器 API 的错误 `detail` 与日志;不做 RTL;不做复数以外的语法性别;不引入翻译平台(Weblate 等),以后有贡献者再评估。

## 拆分

| PR  | 分支                     | 内容                                                                                                                 |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1   | `feat/i18n-package`      | `packages/i18n`(格式化、日期数字、locale 解析、字典迁移)、Web 改用、系统提示词模板、`check:i18n`、翻译贡献文档、测试 |
| 2   | `feat/docs-site`         | `apps/docs` 骨架、双语、搜索、部署工作流、快速开始 / 配置模型 / 安全 / FAQ                                           |
| 3   | `docs/docs-site-content` | 渠道、插件开发、API 参考生成、ADR 汇总、更新日志页、M9 自检                                                          |

## 验收对照(M9)

- 切换语言无硬编码残留:`pnpm check:i18n` 在 CI 通过,另有 Playwright 冒烟切换语言后断言页面无另一语言的固定文案。
- 文档站自动部署、搜索可用:`docs.yml` 构建成功;Pagefind 索引在构建产物中存在(CI 检查);线上部署与搜索实测需业主启用 Pages 后确认。
