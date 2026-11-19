# M12 · UI redesign, tool-result visualization and app icon

- Status: **proposed. Design only; no feature code is in this PR.** The owner confirms (or changes) this document before any implementation PR is opened.
- Date: 2026-11-19
- Related: ADR 0046 (security boundary of the built-in browser and tool-result visualization), ADR 0009 (Web UI), ADR 0010 (approvals), ADR 0021 (voice, `VoiceOrb`), ADR 0028 (egress targets), ADR 0044 (desktop app), ADR 0045 (mobile / PWA)
- Files in this PR: `docs/design/tokens.css` (design tokens), `docs/design/prototype/` (static HTML prototype that the screenshots were taken from; `index.html` is excluded from Prettier in `.prettierignore` because Prettier's reformatting of whitespace-sensitive code lines breaks them), `docs/design/icons/app-icon.svg` and `app-icon-small.svg` (draft app icon and its small-size cut), this document, ADR 0046.

UI copy is Chinese (brief point 10); this document is English (external-facing text rule). Every open question carries a recommended value; unanswered questions are implemented as recommended, except merging, sending mail and anything touching the data directory, which always wait for an explicit yes.

## 1. What changes, in one page

| Area           | Today                                                                  | After M12                                                                                       |
| -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Look           | System light/dark, blue accent (`#0a66c2` / `#5ea2ff`)                 | Matte obsidian dark, one ice-cyan accent, 1px hairline cards, no glow, no purple                |
| Home           | Chat page with a small `VoiceOrb` indicator (green/purple/blue/orange) | Workbench: 40% core orb + subtitles + RUNNING TOOLS on the left, tool-driven panel on the right |
| Tool results   | Generic `ToolCard` with JSON                                           | File tree + preview, red/green diff with the existing approval bar, mail card, memory card      |
| Browsing       | `web.fetch` (text only, per-call approval)                             | Built-in browser panel (desktop) + `browser.*` tools; click/fill/submit need approval           |
| Settings       | One long scrolling page                                                | Section tabs + side menu + card grid, only metrics that existing APIs provide                   |
| Icons          | Mixed text/emoji glyphs                                                | One single-line icon set (1.75px, `currentColor`); minimal cat-paw app icon everywhere          |
| Name / version | "FatCat-AI" in most places; installer says `0.0.0`                     | "FatCat-AI" everywhere, version read from the package, Chinese tray and copy                    |
| Phone          | PWA with the desktop layout squeezed                                   | Same tokens, single column, bottom tab bar                                                      |

The prototype (`docs/design/prototype/index.html`, open it in a browser; `#wb-files`, `#wb-diff`, `#wb-mail`, `#wb-memory`, `#wb-browser`, `#settings-models`, `#ds`, `#phone-diff`, `?state=listening|thinking|speaking`, `?static=1`) is a **throwaway** HTML/CSS/canvas page that implements the reference images; it is not wired to the app and is not shipped. The implementation PRs re-build it with React in `apps/web` and `packages/ui`.

## 2. Review of the brief and the reference images (please read first)

Things I found while implementing the references. None was changed silently; each is a question in section 14.

1. **`#121512` (surface) looks like a typo.** It is the only token with a green tint (R=18, G=21, B=18); the other dark tokens are blue-tinted (`#0B0D1D`, `#12151E`, `#1F2633`). Rendered, panels read slightly olive next to the navy base (visible in the screenshots). The reference sheet prints the same value, so it is in the source art too. I kept it as given in `tokens.css` (one line to change). Candidates: `#121216` (neutral) or `#12151E` (same as the secondary surface; then "surface" and "secondary surface" collapse into one).
2. **Text `#E2E8FF`** is a blue-tinted white (Tailwind's slate-200 is `#E2E8F0`). It is fine (15.8:1 on the base) and matches the reference; noted only because it differs from the common value.
3. **`#1F2633` borders are only 1.27:1 against the base.** That is right for decorative hairlines, but inputs, buttons and switches need about 3:1 to be seen (WCAG 1.4.11). I added `--border-strong: #5b687c` (3.4:1) for interactive controls only. This is an addition to the brief.
4. **Colours the brief does not define but the design needs.** Red/green for diffs and errors, a warning tone for risk chips, a focus ring, accent tints, radii, spacing, motion. Proposed in `tokens.css` and marked `[proposed]`. They are desaturated and used only for diffs, errors and risk labels so the accent stays the only chromatic brand colour.
5. **The reference shows "FATCAT OS v1.4.2" and the model "FatCat-Coder-v2".** The brief says the product name is FatCat-AI and the version comes from the package, so the prototype shows "FatCat-AI" with the version read from the root `package.json` (`node docs/design/prototype/sync-version.mjs` writes `version.js`; today that is `0.0.0`, the bug of section 10) and the model pill shows the real default model, or 「未选择模型」 when none is set.
6. **Only three reference images arrived: the workbench twice (identical) and the design sheet.** There is no reference for the settings page, so section 9 is designed from the brief's text. If a settings mockup exists, please send it.
7. **The reference sheet's icon set (12 cyber-cat illustrations) contradicts brief point 9** (sidebar and file tree use plain single-line icons; cat illustrations only for empty states). I followed the brief; the cat appears in the orb, the empty states and the app icon.
8. **"M12" is already used in the development plan** (section 9: "M12 · Stabilization and 2.0"). Recommendation: this redesign keeps the name M12 (owner's choice), and the old M12 is renumbered M13 in the plan in a docs-only follow-up. I did not edit the plan in this PR.
9. **Dark only?** The brief describes one dark theme; the app today supports system/light/dark (ADR 0009). Recommendation in Q2.
10. **The icon pictures** (paw, folder, gear) were grey placeholder shapes, so they were used only as size/position hints, not as art.

## 3. Visual language

### 3.1 Tokens

All raw values live in `docs/design/tokens.css` (moved to `packages/ui/src/tokens.css` in the first implementation PR, imported by the web app, the PWA and the desktop shell). Components use only the semantic names.

| Token                          | Value                             | Use                                                            |
| ------------------------------ | --------------------------------- | -------------------------------------------------------------- |
| `--bg`                         | `#0B0D1D`                         | App background                                                 |
| `--surface`                    | `#121512`                         | Cards and panels (see Q1)                                      |
| `--surface-2`                  | `#12151E`                         | Inputs, hover rows, glass cards, rows inside cards             |
| `--border`                     | `#1F2633`                         | 1px hairlines between regions and around cards                 |
| `--accent`                     | `#38BDF8`                         | **Only** selected menu item, status indicators, primary button |
| `--fg`                         | `#E2E8FF`                         | Body text                                                      |
| `--muted`                      | `#94A3B8`                         | Secondary text, default icon colour (7.5:1 on the base)        |
| `--border-strong`              | `#5b687c`                         | proposed: borders of interactive controls                      |
| `--danger` / `--ok` / `--warn` | `#e5857f` / `#7fc99a` / `#d8b36a` | proposed: diff, error, risk label only                         |

Accent rules (enforced in review, and by a small stylelint-style test in PR 1 that greps for hard-coded colours outside `tokens.css`):

- The accent appears on: the selected menu / rail item, status dots and badges (ONLINE, RUNNING), the primary button, focus rings, the AI-operated element outline in the browser panel, wave bars and the active tool row's spinner.
- It never appears on: body text links in running copy (use underline + `--fg`), large fills, backgrounds, gradients, shadows. **No glow, no box-shadow halos, no purple.** Depth comes from two surface steps (`--surface`, `--surface-2`), 1px borders, a faint inner top highlight and a soft low-contrast drop shadow on cards; no coloured halos. The one exception to "no blur" is the RUNNING TOOLS glass card (8–12px backdrop blur, matte tint, 1px border); it falls back to a solid `--surface-2` where `backdrop-filter` is unsupported.
- Buttons: primary = accent fill, `--accent-fg` text (9:1), pill radius. Secondary = transparent, `--border-strong`. Hover = accent border and text. Disabled = muted at 60%.

### 3.2 Typography

Body 14px sans-serif (system stack with PingFang SC / Microsoft YaHei / Noto Sans CJK SC for Chinese; no web font download, which keeps the zero-egress promise and the installer small). Code 12px monospace (`ui-monospace`, Cascadia, Consolas). Card titles 16px / 600, captions and badges 12px. The 32px header exists only on the design sheet. Line height 1.55 body, 1.6 code.

### 3.3 Shape, spacing, motion

Radii 6 / 10 / 14px and pill; spacing scale 4-8-12-16-24-32; 1px borders. Motion 120–200ms ease-out for hover and panel switches; every animation respects `prefers-reduced-motion` (the orb draws one static frame, spinners become a static glyph).

### 3.4 Icons

One in-repo single-line set in `packages/ui` (`<Icon name="folder" />`, inline SVG sprite, no icon library dependency): 24px viewBox, **1.75px stroke, no fill, round caps/joins, colour `currentColor`**. Default `--muted`; active `--accent`; sizes 16 / 20 / 24 (the 1.75px stroke stays crisp at 16px because the paths sit on a 0.5px grid). The prototype has 25 icons (paw, folder, file, files, gear, search, diff, mail, brain, globe, terminal, mic, lock, cloud, trash, clock, chat, plug, pulse, cat, arrows, x, check, play) which are the starting set; each implementation PR adds only what it uses. All icons are drawn here (no third-party artwork, so no licence question). Cat illustrations (the large line-art cat in the orb, the empty-state cat) are separate artwork, never used as navigation icons.

## 4. The core orb

A silver-white wireframe sphere of particles with a small line-art cat inside. It replaces the current `VoiceOrb` colours; the existing five-state machine (`idle` / `listening` / `thinking` / `speaking` / `executing`) and the level-driven pulse are kept, and `executing` maps to the `thinking` look (tool activity is shown by RUNNING TOOLS, not by another colour).

| State            | Particles (of 1400 max) | Motion                                                                                                              | Extra                      |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Listening (聆听) | 50%                     | Slow spin (0.12 rad/s), 1.2% breathing, almost no jitter                                                            | Wave bars nearly flat      |
| Thinking (思考)  | 100%                    | Fast spin (0.5 rad/s), more jitter, a cyan band of particles sweeps pole to pole                                    | Wave bars flat             |
| Speaking (说话)  | 78%                     | Medium spin; particles lift radially with the output level (TTS level if available, otherwise a synthetic envelope) | Wave bars follow the level |

- **Only density and motion change between states.** Colours are fixed: silver-white particles, about 18% tinted ice-cyan, wireframe lines at 13% alpha. No per-state hue.
- Below the sphere: the state text ("正在聆听" / "正在思考" / "FatCat 正在说话", the state word in the accent), the 36-bar ice-cyan wave, then the last user and assistant lines as subtitles.
- **Performance:** Canvas 2D, ~60fps target, a single `requestAnimationFrame` loop shared by all orbs, paused when the page is hidden. A frame-time monitor lowers the particle count by 20% steps (floor 35%) after ~45 slow (>24ms) frames, never raises it again within a session; devices with `hardwareConcurrency <= 4` or `deviceMemory <= 4` start at 60%. The wireframe is 6 rings + 6 meridians (about 780 line segments), cheap enough to keep. `prefers-reduced-motion`: one static frame per state change. Canvas unavailable: text only (existing behaviour).
- The prototype's `prototype.js` is the reference for the numbers; PR 2 turns it into a tested pure module (state presets, adaptive quality, particle projection) plus a thin canvas adapter, next to the existing `voice-orb.ts` logic and tests.
- The cat is an SVG overlay (about 1.5px silver stroke), so it stays crisp and is replaceable by final artwork without touching the canvas code.

## 5. Workbench layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 🐾 FatCat-AI v1.0.0   [ 🔍 搜索文件、命令,或直接提问…   Ctrl K ]   (🐱 模型:xxx) │  56px top bar
├──────────────────────────────┬──┬───────────────────────────────────────────┤
│ RUNNING TOOLS (glass card)   │R │                                           │
│                              │a │   tool-type panel                         │
│        ◯ core orb ◯          │i │   (files / diff / mail / memory /         │
│                              │l │    browser)                               │
│ 正在聆听 ● ||||||||||||       │  │                                           │
│ 你: …  FatCat: …              │  ├───────────────────────────────────────────┤
│        left ≈ 40%            │  │ approval bar / status bar                 │
└──────────────────────────────┴──┴───────────────────────────────────────────┘
```

- **Top bar:** paw logo + "FatCat-AI" + version (from `GET /api/v1/meta` `serverVersion`, so it is the version of the core actually running; the desktop shell shows its own package version in About); global search box; current model pill (accent outline; label of the profile that the next turn will use, from `GET /api/v1/settings` + `GET /api/v1/models`; click opens the model picker).
- **Global search** (files / commands / questions): one box, three result groups. Files = `GET /api/v1/items/search` (the item index already covers files, mail and memories); Commands = a static client-side list (switch panel, open settings, new session, toggle voice); anything else is sent as a question to the current session (so the box never silently searches the network). `Ctrl/Cmd+K` focuses it.
- **Left (≈40%, min 340px):** orb, state text, wave, subtitles, and the RUNNING TOOLS glass card at the top-left. RUNNING TOOLS lists tools of the current run, newest last: tool name + short argument summary (the existing `activityLabel` / run events), a spinner while running, a check when done, a cross when failed, a clock when waiting for approval. At most 4 rows, older ones collapse into "+N". Data: the existing run event stream (`tool-call`, `tool-result`, `approval-required`, `approval-resolved`); nothing new on the server.
- **Right:** a 48px icon rail (files, search, changes, mail, memory, browser; settings at the bottom) and the panel. **The panel follows the latest tool call by default** (a tool call switches it, a manual rail click pins it until the next run), so the user does not have to hunt for what the assistant is doing.
- **Status bar:** core status (from `/healthz`), cursor/language when a file preview is shown.
- Below 900px the layout collapses to the single column of section 11.

## 6. Tool-result visualization

Principle: the panels render **tool results and approval payloads that the existing event stream already delivers** (public API only, ADR 0009). They do not add file-system or mail endpoints. The tool-result data is untrusted (ADR 0010, ADR 0046 §6): always rendered as text, never as HTML, never followed as instructions.

| Tool (today)                                              | Panel                                                  | Data used                                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fs.list`, `fs.search`                                    | Explorer tree                                          | Listing output; the tree is built from the paths returned, rooted at the approved root                                                                                               |
| `fs.read`                                                 | Editor preview                                         | Returned text with line numbers, 12px mono, the requested line range highlighted with the accent tint; syntax colours from the existing `highlight.js` (muted theme in `tokens.css`) |
| `fs.write`, `fs.move` (the "edit code" case)              | Diff + approval bar                                    | Old and new content, see below                                                                                                                                                       |
| `mail.list`, `mail.search`, `mail.read`, `mail.summarize` | Mail cards                                             | Message fields from the result; body shown as text with the "external content, not executed" notice (existing untrusted-block rule)                                                  |
| `mail.draft`, `mail.send`                                 | Mail card with draft state + the existing approval bar | Draft fields; sending always needs approval (unchanged)                                                                                                                              |
| memory tools, `kb.search`, `items.*`                      | Memory / item cards                                    | Fact text, type chip, source link, last-used; undo/keep use the existing memory endpoints                                                                                            |
| `web.fetch`, `browser.*`                                  | Browser panel (desktop) or a text card (web / phone)   | See ADR 0046                                                                                                                                                                         |
| anything else (MCP, plugins, `calc`)                      | The current generic card                               | Unchanged                                                                                                                                                                            |

**Diff and approval.** The red/green diff (rows `−` on `--diff-del-bg`, `+` on `--diff-add-bg`, line numbers, 12px mono) is drawn on top of the existing approval flow: the bottom bar shows the action summary, a risk chip (写入), and 拒绝 / 允许 buttons that call the existing `POST /api/v1/approvals/{callId}` decision endpoint with the same payload as today (including the "remember" option where allowed). Nothing is written before 允许. Open question Q5 is where the "old content" comes from: today the approval input of `fs.write` contains the new content only. Recommendation: the server adds an additive, optional `preview` field to the approval (a bounded unified diff computed from the file as it is now, inside the approved root, truncated at 64 KiB). That is a backward-compatible schema addition in `packages/shared` and needs a short ADR addendum; it is done in PR 4. Without it the panel falls back to showing the new content as all-added lines with a notice "no previous version shown".

Large results are capped (first 500 lines / 64 KiB, "show more" fetches the rest from the already-received event, not from disk), so a 100 MB file cannot freeze the UI.

## 7. Built-in browser panel

Desktop shell only (Tauri embeds a native webview); the plain web UI and the phone PWA cannot embed a controllable browser, so there `browser.*` results are shown as text cards (title, URL, extracted text) and the tool still works through the server-side reader where allowed. The panel: back / forward / refresh / address bar (read-only lock + URL, click to type a new URL) / close. The element the AI operates is outlined 1.5px in the accent with a small "AI 正在点击 / 正在填写" label. Navigation and reading are allowed by default; **click, fill and submit each need approval**, the browser session and cookies are isolated from the main UI, and every request obeys the egress allowlist. The full boundary, threat model, tool schema and test list are in **ADR 0046**; the one-paragraph version is in section 12.

## 8. Opening external programs

Only "open this file or URL with the system default program", one tool (`system.open`), risk `external`, **always** requires approval, never pre-authorizable (same class as `mail.send`), argument validated: URL schemes `https`/`http`/`mailto` only, files must lie inside an approved root, no executables or scripts (denied by extension and by the OS "executable" bit), no arguments, no shell. **Simulated mouse / keyboard control is not part of M12**, is not exposed in any API, and stays a later milestone with its own ADR. Details in ADR 0046 §5.

## 9. Settings page

Layout: top section tabs **工作台 / 模型与语音 / 工具插件 / 系统设置**, a left sub-menu per section, a card grid (3 columns on desktop, 2 on tablet, 1 on phone). The existing settings content (egress list, secrets, TOTP, devices, mail accounts, channels, MCP, plugins, time zone…) moves into the matching section unchanged in behaviour; M12 only re-lays it out. The first section ("模型与语音") opens with these six cards, **each backed by an API that exists today; a card whose data is missing shows an honest empty state, never a made-up number**:

| Card       | Shows                                                                                                | Source                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 核心状态   | 运行中 / unreachable, core version, protocol version                                                 | `GET /healthz`, `GET /api/v1/meta` (`serverVersion`, `protocolVersion`)                                         |
| API 延迟   | Latency of the default chat model, **measured on demand** with a "测试连接" button; "—" until tested | `POST /api/v1/models/{id}/test` → `latencyMs` (it makes one outbound request, so it is never run automatically) |
| Token 用量 | Input / output tokens summed over recent sessions                                                    | `GET /api/v1/sessions` → `usage`                                                                                |
| 语音引擎   | Configured STT and TTS profile labels, or "未配置" + link                                            | `GET /api/v1/models` (purpose `stt` / `tts`)                                                                    |
| 模型配置   | Default chat profile, number of profiles, link to manage                                             | `GET /api/v1/settings`, `GET /api/v1/models`                                                                    |
| 语音交互   | The voice switches that exist (read replies aloud, push-to-talk …)                                   | `GET/PUT /api/v1/settings` → `voice`                                                                            |

Decisions the brief left open, with recommendations:

- **"Token 额度" (quota).** No API returns a quota or remaining balance (providers differ, many keys have none), so **the card is "Token 用量" (usage) and shows no quota**. Recommendation Q3: do not invent a quota; if the owner wants a monthly budget, that is a separate feature (setting + server-side counter) with its own PR. Usage is summed from the sessions page(s) the UI already loads (label says "最近 N 个会话"); an additive `GET /api/v1/usage` aggregate is optional and not in M12.
- **API 延迟** is on demand only (no polling, because each probe is a billable outbound request and would add a recurring egress).
- No CPU / memory / disk graphs: the server exposes no such API (memory is measured only, ADR 0041), so they are not shown.
- In the prototype every card carries a small mono caption with its source endpoint; this caption is a review aid and is not part of the shipped UI.
- **Visual elements per card (prototype):** a small sparkline under 核心状态, a ring under Token 用量, a wave under 语音引擎, a small cat line drawing as the empty state of API 延迟 and 模型配置, switches under 语音交互. The sparkline is drawn only from `/healthz` probe timings the page itself takes during the session (no history API exists), and the ring only shows the input / output split of `usage` (not a quota). Graphics marked 「示意」 in the prototype only show layout; in the app, a card without data shows the empty-state drawing and no number.
- Section tabs are larger, centred, with a Chinese title and an English subtitle on two lines (工作台 / Workbench, 模型与语音 / Models & Voice, 工具插件 / Tools & Plugins, 系统设置 / System).

## 10. App icon, name and version

- **App icon:** minimal single-line cat paw (`docs/design/icons/app-icon.svg`, draft): tilted about 12°, four toes of different sizes drawn as outlines, a pad outline with a notch, **one colour (silver) on the base tile** (an earlier draft had a single cyan toe, which read as a drawing mistake). It is deliberately asymmetric and outline-only, unlike the filled, symmetric bear-paw logos it must not resemble. **Small sizes need their own cut:** at 16px the outlined toes merge into a blob (see the 16 / 24 / 32px comparison in the PR), so `app-icon-small.svg` and the sprite's `paw-sm` use dot toes and a heavier stroke below 20–24px; the build script picks the cut by size. Final polish (a tray monochrome variant, maskable safe area, checking 16px on a real Windows tray) happens in PR 1.
- **Generation:** redraw as a clean 1024×1024 SVG master, then `pnpm tauri icon` (Tauri's `icon` command; it needs the Tauri CLI that apps/desktop already uses) writes the full platform set into `apps/desktop/src-tauri/icons` (`.icns`, `.ico`, PNG sizes). The same master produces: the tray icon (monochrome template for macOS, 32px colour for Windows/Linux), `apps/web/public/icons/*` (192, 512, maskable 512, apple-touch), the favicon, `manifest.webmanifest` icons and colours (`background_color` / `theme_color` → `#0B0D1D`), `<meta name="theme-color">`, and the assistant avatar (a round crop of the paw on `--surface-2`). A script `scripts/make-icons.mjs` regenerates everything from the one SVG so the set cannot drift; CI checks the generated files are up to date.
- **Name:** "FatCat-AI" in the window title, tray tooltip, About, PWA name, installer, docs; the reference's "FATCAT OS" is not used. Remaining "AI-Personal" strings are found with the existing placeholder check.
- **Version bug (installer says 0.0.0):** the root and `apps/desktop` `package.json`, `tauri.conf.json` and `src-tauri/Cargo.toml` all say `0.0.0` today, and there is no release yet (CHANGELOG). Plan: `tauri.conf.json` `version` points to `../package.json` (Tauri v2 supports a path), `apps/desktop/package.json` is the single source of truth and is bumped by the release process (see ADR 0032, release flow), the web UI shows the core's `serverVersion`, and a CI check fails the desktop build when the installer version differs from the tag. Which number a first release carries is the owner's decision (Q7).
- **Tray and copy:** the tray menu, tooltips and dialogs are Chinese (from the `zh-CN` locale; English users keep `en`). The tray gets: 打开 FatCat-AI / 状态 / 退出. Desktop copy goes through `@fatcat-ai/i18n` so the English build is not lost.

## 11. Phone / PWA

Same tokens (one stylesheet). Below 900px: single column, top bar without the search box (a search icon opens it full-screen), the orb at about 50% width, RUNNING TOOLS full width above it, the current panel (diff + approval, mail card, memory card, text browser result) below, and a bottom tab bar (对话 / 文件 / 浏览器 / 设置) with 44px touch targets and safe-area padding. Settings cards go single column. The orb starts at the reduced particle count on phones. The prototype's `#phone-diff` view is the reference. Offline cache, pairing and the service worker (ADR 0045) are unchanged.

## 12. Security boundary (summary; ADR 0046 is binding)

1. The browser webview is a separate Tauri webview with its own data store (separate cookie jar / storage directory, never the main window's session), no access to the app's IPC commands, no access to `localhost` core API cookies, and a navigation filter that enforces the same egress allowlist as the server (HTTPS only; private / loopback / link-local / metadata addresses blocked).
2. `browser.open` and `browser.read` are allowed without per-call approval within the allowlist; `browser.click`, `browser.fill` and any submit are `external` risk, **approval every time, never pre-authorizable**. Page text returned to the model is wrapped as untrusted data.
3. Open-external-program: one `external` tool, approval every time, strict argument validation.
4. No simulated mouse/keyboard, no screen capture of other apps, no script injection into pages by the model.
5. Visualization panels render text only, with sanitized links, caps on size, no remote images loaded from tool results.

## 13. Implementation plan (one PR = one complete batch)

Each PR ships back end, front end, tests and docs together, with before/after screenshots and the commands/results in the description, per the repo PR rules. They are opened one at a time, in this order, each after the previous one is merged and the owner has confirmed this design.

| PR  | Branch                        | Contents                                                                                                                                                                                                                                                              | Risk                                          |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 0   | `docs/m12-ui-redesign-design` | This document, `tokens.css`, prototype, draft icon, ADR 0046. No app code.                                                                                                                                                                                            | low                                           |
| 1   | `feat/identity-tokens-icons`  | `tokens.css` into `packages/ui`, old CSS variables mapped (§14), shell and sidebar on the new tokens, single-line icon set, final app icon + `scripts/make-icons.mjs`, tray / favicon / PWA manifest / avatar, "FatCat-AI" name and package-version fix, Chinese tray | medium (installer, tray: needs Windows check) |
| 2   | `feat/core-orb`               | New orb (states, density, adaptive quality, wave bars) replacing the `VoiceOrb` look; pure-logic tests; reduced motion                                                                                                                                                | low                                           |
| 3   | `feat/workbench-layout`       | Top bar, global search, left stage, RUNNING TOOLS from run events, rail + panel switching, file tree + preview                                                                                                                                                        | medium                                        |
| 4   | `feat/tool-visualizers`       | Diff + approval bar (incl. the optional `preview` approval field and ADR addendum), mail cards, memory cards                                                                                                                                                          | high (approvals)                              |
| 5   | `feat/settings-redesign`      | Section tabs, side menu, the six data cards, existing settings moved into sections                                                                                                                                                                                    | low                                           |
| 6   | `feat/browser-tool`           | Server side: `browser.*` tool contracts, policy, egress registration, untrusted wrapping, host-side adapter interface, full security tests (no UI)                                                                                                                    | high (security, egress)                       |
| 7   | `feat/browser-panel`          | Tauri webview panel (isolated data store, navigation filter, IPC lockdown, highlight overlay), approval bar; needs Windows + macOS check                                                                                                                              | high                                          |
| 8   | `feat/open-external`          | `system.open` tool + approval + validation tests                                                                                                                                                                                                                      | high                                          |
| 9   | `feat/narrow-layout`          | Phone single column, bottom tab bar, PWA polish                                                                                                                                                                                                                       | low                                           |

Per-PR testing follows the repo rules: pure logic gets 2–3 unit tests (orb presets and adaptive quality, diff builder, domain / scheme validators), every touched screen is clicked in a real browser with screenshots, and high-risk PRs list manual steps and which parts need a Windows machine. Items that need the owner's hardware (Windows tray, WebView2 behaviour, a real mailbox) are listed in the PR and not done by me.

## 14. Open questions (recommended answers; unanswered = the recommendation is implemented)

| #   | Question                                                                                     | Recommendation and why                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Is surface `#121512` intended? It is green-tinted next to the blue-tinted rest.              | Keep it for now (matches the reference sheet). If it is a typo, change one line in `tokens.css`; I suggest `#121216`. Decide before PR 1.                                                                                                                                                |
| Q2  | Dark only, or keep light / system themes?                                                    | Ship dark as the only redesigned theme; keep `data-theme=light` working on the old palette until a light token set is designed (not in M12). Fewer states to test; the brief only describes dark.                                                                                        |
| Q3  | "Token 额度": there is no quota API.                                                         | Show "Token 用量" (usage) only; no invented quota.                                                                                                                                                                                                                                       |
| Q4  | Extra semantic colours (red/green/amber), `--border-strong`, radii, motion (§3).             | Accept as proposed; they are used only for diffs, errors, risk chips and control borders.                                                                                                                                                                                                |
| Q5  | Where does the diff's old content come from?                                                 | Additive optional `preview` on the approval, computed server-side (bounded). Fallback: all-added view with a notice.                                                                                                                                                                     |
| Q6  | Rename old M12 in the plan to M13?                                                           | Yes, docs-only follow-up after this design is confirmed.                                                                                                                                                                                                                                 |
| Q7  | First release version number (installer shows `0.0.0` because nothing was released).         | `1.0.0` for the first tagged release, set by the release process, as the plan says.                                                                                                                                                                                                      |
| Q8  | Brief says navigation is allowed by default, ADR 0010 says a URL can leak conversation data. | `browser.open` is allowed without a prompt for hosts already allowed (ADR 0039 domain scopes); the first new host asks once per session (ADR 0046 §4.1). `browser.*` ships disabled until switched on in settings (ADR 0046 §4.6). Related ADR 0046 questions Q-A..Q-F are listed there. |
| Q9  | Browser engine on Linux (WebKitGTK) and per-platform isolation limits.                       | Ship Windows (WebView2) and macOS (WKWebView) first; Linux after a manual check. ADR 0046 §3 lists the per-platform isolation facts to verify in PR 7.                                                                                                                                   |
| Q10 | Docs language: this document and ADR 0046 are in English, existing ADRs are in Chinese.      | English as instructed for this PR; say if you want a Chinese copy of the ADR.                                                                                                                                                                                                            |

Old-to-new CSS variable mapping for PR 1: `--bg` → `--bg`; `--panel` → `--surface`; `--fg` → `--fg`; `--muted` → `--muted`; `--border` → `--border`; `--accent` → `--accent` (+ `--accent-fg`); `--danger`/`--ok`/`--warn` → same names; `--code-*` → same names with the muted values. The names that already exist keep their meaning, so most existing CSS recolours without edits.

## 15. Not in M12

Simulated mouse / keyboard, screen capture of other apps, a light theme, a token quota/budget feature, system resource graphs, plugin-contributed panels, a web font, a 3D (WebGL) orb. The particle-drill-down knowledge map stays in its own milestone.

## 16. Acceptance of this design PR

- The prototype opens in a browser and matches the reference images (screenshots in the PR).
- Tokens match the brief exactly; every addition is marked `[proposed]`.
- Every settings card names the existing API behind it.
- ADR 0046 covers webview isolation, egress allowlist, approval for click / fill / submit, external-program approval and the no-simulated-input rule.
- The PR list in §13 is the agreed batching, or the owner replaces it.
