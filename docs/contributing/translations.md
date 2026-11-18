# Adding a language / 新增界面语言

English first, 中文说明在后。

## English

The Web UI text lives in `packages/i18n/src/locales/`. `zh-CN.ts` defines the keys, `en.ts` must have exactly the same keys (the type checker enforces it). Messages use a small ICU subset: `{name}`, `{n, plural, one {# file} other {# files}}` (`#` is the number) and `{kind, select, a {…} other {…}}`. There is no quote escaping, so apostrophes are written as they are.

To add a language, for example `fr`:

1. Add `'fr'` to `LOCALES` and a self-name to `LOCALE_NAMES` in `packages/i18n/src/locale.ts`, and to the `Locale` enum in `packages/shared/src/settings.ts` (a backward-compatible addition to the API; write an ADR note if you change the enum).
2. Copy `locales/en.ts` to `locales/fr.ts`, translate the values, and register it in `dictionaries` in `packages/i18n/src/index.ts`.
3. Add a `fr` entry to each template in `packages/i18n/src/prompts.ts` and to the label tables in `packages/agent/src/labels.ts`. Missing entries fall back to English.
4. Run `pnpm --filter @fatcat-ai/i18n test` (keys, placeholders and syntax are checked) and `pnpm check:i18n`.
5. Open the Web UI, choose the language in Settings, and click through the pages.

Do not put UI text in components: use `t('some.key')`. `pnpm check:i18n` fails on hard-coded text; the rare exceptions (product names, code) go into `scripts/i18n-allowlist.json` with a reason.

## 中文

界面文案在 `packages/i18n/src/locales/`:`zh-CN.ts` 定义键,`en.ts` 必须有完全相同的键(类型检查保证)。消息用小型 ICU 子集:`{name}`、`{n, plural, one {# 个} other {# 个}}`(`#` 是数值)、`{kind, select, a {…} other {…}}`。不做引号转义,撇号照写。

新增语言(以 `fr` 为例)的步骤见上面的英文清单:在 `locale.ts` 与 shared 的 `Locale` 枚举里登记,复制 `en.ts` 翻译,在 `prompts.ts`、`labels.ts` 补模板(缺项回落英文),运行 `pnpm --filter @fatcat-ai/i18n test` 与 `pnpm check:i18n`,最后在设置页切换语言逐页检查。

组件里不要写界面文字,一律 `t('键')`;`pnpm check:i18n` 会拦截硬编码文本,少数例外写进 `scripts/i18n-allowlist.json` 并注明理由。
