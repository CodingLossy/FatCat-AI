# Changelog

All notable user-visible changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no tagged releases yet: version numbers start with the first release (planned for M5), so everything below is under "Unreleased", grouped by milestone. A Chinese summary follows the English text (中文摘要见下方).

## [Unreleased]

### M12 · UI redesign (in progress)

#### Added

- Workbench on wide screens (900px and up): a top bar with the name, the running core's version, a search box (files from the item index, commands, or a question sent to the current chat; Ctrl/Cmd+K focuses it) and a model pill that shows the profile the next turn will use, or "no model selected". The left side is the orb plus a RUNNING TOOLS card filled from the live run (running, done, failed, waiting for approval; older calls collapse to +N). The right rail switches panels; a tool call follows into the matching panel until you pin one by clicking the rail. The files panel builds a tree and a read-only preview from `fs.list` / `fs.search` / `fs.read` results already delivered to the page. Below 900px the previous sidebar stays, so phones are unchanged until the narrow-layout pull request. Chinese summary: 宽屏工作台(顶栏版本号、全局搜索、真实默认模型或「未选择模型」、左侧核心球与按本轮运行事件绘制的 RUNNING TOOLS、右侧导轨切换面板、文件树与预览只使用已经返回的工具结果);900px 以下仍是原来的侧栏。

- Workbench idle layout (M12): when nothing is running the orb fills the window and no panel is shown. The side panel is now a floating translucent card on top of the orb; it opens by itself when a tool needs it (`panelForTool`), closes 8 seconds after the run ends, and stays open while pinned or while an approval is waiting; Esc, the close button and the new Ctrl/Cmd+K command "Collapse panel" close it. New side-effect-free tool `ui.panel` (`open` files / changes / mail / memory / browser, or `close`) so you can ask for a panel by voice or typing. A window-wide glow follows the orb's energy and speech volume (static with reduced motion). The left sidebar has two states, expanded (icons, labels, sessions) and a 56 px icon bar, toggled by the button or Ctrl/Cmd+B and remembered on this device; narrow windows keep the drawer. The top bar became a small capsule (title, search, model) and the message box floats at the bottom centre. New installs start in the dark theme. When the plugin market index cannot be downloaded the reason is shown, and a host resolved into the fake-IP range links straight to Settings → Network & egress. Explanatory paragraphs on the plugin, task, agent, mail, item, device, MCP and egress pages were removed; unused wording keys were deleted. Chinese summary: 工作台空闲布局(空闲无面板、主视觉铺满窗口;面板为浮动玻璃卡,工具调用时自动打开、运行结束 8 秒后收起,固定或有待审批时不收,Esc / 关闭按钮 / Ctrl+K「收起面板」;新增无副作用工具 ui.panel;全窗口光晕;左侧栏展开 / 56px 两态,Ctrl+B,记住;左上胶囊、底部居中输入框;新安装默认深色;插件市场索引失败显示具体原因并可跳到「允许 fake-IP 段」;精简说明文案)。

- Browser tools for the assistant (ADR 0046 section 13): `browser.open` loads a public web page, `browser.read` returns its title and text in pieces of up to 20,000 characters, and `browser.screenshot` is available only once the desktop app provides a renderer (otherwise it answers `browser_unavailable`). Off by default: turn it on under Settings → Tools & Plugins → Browser. When on, the first visit to a new host in a conversation asks for approval once and the same host is not asked again in that conversation; a long query string in the address adds a "carries data" warning. Only http and https are allowed; local and private addresses, IP addresses and internal host names are refused before any prompt, the address is checked again after DNS and at every redirect, a redirect to a host you have not approved is refused, no cookies are sent, and responses are limited (15 s, 1 MiB, 2 browsers at once, 40 calls per run). Page text is untrusted content. Click, fill and submit are not included yet. Chinese summary: 新增 AI 浏览器工具 browser.open / read / screenshot(设置 → 工具与插件 → 浏览器,默认关闭);每个会话首次访问新主机审批一次;只允许公网 http / https,内网、本机、IP 地址在审批前拒绝,DNS 解析后与每次重定向再校验,不带 cookie,超时 / 大小 / 并发 / 次数都有上限;截图需要桌面应用;点击、填写、提交留到面板 PR。

- Built-in browser panel in the desktop app (ADR 0046 section 14; Windows and macOS only, Linux comes later): the Browser tab of the workbench has back / forward / reload, an address bar (the lock and the host name; click to type a new address) and a close button, and shows the page in a separate native view with its own private session: cookies, storage and cache are wiped when the panel closes (and on the next start if the app was killed). The view has no access to the app: no Tauri commands, no injected scripts, no downloads, no pop-up windows, and on Windows every permission prompt (camera, microphone, location, notifications) is refused. Only https pages of public host names can be opened (http is upgraded, IP addresses, `localhost`, internal names, embedded credentials and `file:` / `data:` / `blob:` / `javascript:` are refused, also for redirects and links); a blocked navigation shows a notice that names the host only. Known gaps, shown in the panel: requests a page makes for images and scripts are not limited by the egress allow-list yet (no filtering proxy), and macOS may still ask you about camera or microphone access. `browser.screenshot` now works when the desktop app is open (Windows first; macOS answers `browser_unavailable`): the server asks the app over the WebSocket, the app loads the page in the panel and returns the picture through the new `POST /api/v1/tool-calls/{callId}/result` (owner session only, one answer per call, expires after 20 s). The web UI now ships a Content-Security-Policy (same-origin only). The assistant cannot click or type in the page yet. Chinese summary: 桌面版内置浏览器面板(后退 / 前进 / 刷新 / 地址栏 / 关闭;独立的无痕会话,关闭即清除;页面没有任何 IPC、不能下载、不能弹窗,Windows 上权限请求一律拒绝;只允许公网 https,跳转与链接同样检查,被拦截时提示主机名);已知缺口:网页子资源请求暂不受出站白名单限制、macOS 可能仍弹出摄像头 / 麦克风询问;`browser.screenshot` 在桌面应用打开时可用(先做 Windows),经新的 `POST /api/v1/tool-calls/{callId}/result` 返回;界面新增内容安全策略;AI 还不能在页面里点击或输入。

- Tool results as cards (ADR 0046 sections 7 and 12): a pending `fs.write` approval shows a red/green diff with line numbers above the existing Approve / Reject bar; the server adds an optional, display-only `preview` to the `approval-required` event (computed inside the approved folders, bounded to 500 lines / 64 KiB, not stored; without it the card shows the new content as added lines). Mail results show as text cards marked "external content, never executed", `mail.draft` as a draft card, and memory search results as a list with type tags. Control and bidirectional characters are shown as visible markers. Approval behaviour is unchanged. Chinese summary: 工具结果卡片(文件写入审批显示红绿差异、邮件卡片、记忆卡片);差异预览只用于显示,不影响批准什么。

- Redesigned Settings page (tabs follow the WAI-ARIA tab pattern with arrow keys, Home and End; token usage is labelled as approximate; the core health probe pauses while the page is hidden; the auto-send and auto-speak switches are back on the Voice page): four section tabs (Workbench, Models & Voice, Tools & Plugins, System), a side menu per section and a card grid (3 / 2 / 1 columns). Models & Voice opens with six cards backed by existing endpoints: core status (health, version, a session-local latency line), API latency (measured only when you press Test connection, never automatically), token usage over the last 5 sessions (input / output share, no quota), voice engine, model setup and voice interaction; cards without data show an empty state instead of a number. Existing settings (folders, mail, channels, MCP, pre-authorizations, plugin market, account and devices, secrets, network and egress) moved into the matching section with unchanged behaviour. Chinese summary: 设置页重新布局(分区标签、侧栏子菜单、卡片网格、六张由现有接口支撑的数据卡片),原有设置按功能归入各分区,行为不变。

- Knowledge (ADR 0046 section 17): the "Knowledge map" and "Memory" entries are merged into one "Knowledge" entry (sidebar, drawer and Ctrl/Cmd+K). It opens the hero in knowledge mode: the first level is the three memory kinds (semantic, episodic, procedural) and the top categories of the item index. In the Tech theme, choosing a star moves it to the centre and spreads its children into a named constellation; choosing a child shows a dark glass bubble with one sentence of the original text, and the bubble opens a card with the full text, its source, edit and delete (memories) and pin. Pins are kept on this device only (no data or API change). A breadcrumb capsule sits at the top left, Esc goes back one step (card, bubble, then level), search lights up every match and the path to it, memories in an open conflict have a red ring, and one screen shows at most about 300 nodes with "Load more" for the rest. Every node is also reachable with the keyboard (Tab, arrow keys, Enter). The List view keeps the previous pages for bulk management. The old particle sphere and memory map are removed; data and endpoints are unchanged. Chinese summary: 「知识地图」和「记忆」合并为一个「知识」入口,主视觉切到知识模式:第一层是记忆三类和知识顶层分类,科技主题点亮一颗星炸开成带名字的星座网,点子项浮出一句原文的玻璃气泡,点气泡打开全文卡片(来源、编辑、删除、置顶,置顶只存本机);左上胶囊面包屑、Esc 逐级返回、搜索点亮命中路径、冲突记忆红圈、一屏最多约 300 个节点其余加载更多、键盘可操作;列表视图保留批量管理;移除旧的粒子球与记忆地图,数据和接口不变。

- Open files and links with the default program (ADR 0046 sections 5 and 20): a new `system.open` tool asks the desktop app to open a file inside the authorized folders, or an https / http / mailto address, with the computer's default program. It is off until you turn on Settings → Tools & Plugins → Built-in browser → "Let the assistant open files and links in the default program", and even then every call needs your approval and it can never be pre-authorized. Programs and scripts are never opened: the core refuses other address schemes, addresses with credentials, files outside the authorized folders (links are resolved first), folders, files whose last extension is not a common document, image, audio or video type (an allowlist: pdf, txt, docx, xlsx, png, jpg, mp3, mp4, …; files without an extension and Windows alternate data streams are refused too) and, on macOS and Linux, files marked as executable, all before any approval appears; the desktop app checks again before opening, passes exactly one argument to the system opener and no shell. Without the desktop app the tool answers that it needs it. The approval card shows the resolved path or full address. The desktop client now declares an `open` capability and the result endpoint accepts `{ "ok": true, "opened": true }` (both additive). CI now fails if a synthetic mouse / keyboard input library or call appears (`pnpm check:no-input-sim`). Chinese summary: 新增 `system.open`:由桌面应用用系统默认程序打开授权目录里的文件或 https / http / mailto 网址;设置里默认关闭,打开后每次都要批准、永不能预授权;只打开常见的文档、图片、音视频,程序和脚本一律不打开(扩展名允许清单、可执行位、目录、目录外路径、链接解析后再查),审批前就拒绝,桌面端打开前再查一次,不经 shell;新增 CI 检查:出现模拟鼠标键盘的依赖或调用即失败。

- Cat theme (ADR 0046 section 19): a light theme on cream (#FFF6EC) with cocoa text (#3B2A20) and an orange (#F28C38) single-line drawing of a sitting cat in the middle, with small sparks along the line. Its ears twitch while listening, its tail swings while thinking, and light flows along the outline while speaking (brighter and faster with the voice). In knowledge mode the sparks on the line are the first level; opening one draws thin whisker-like lines to its children, and the bubble is white with rounded corners and a paw print. Panels have 20px corners, the switch thumb is a paw print and the slider thumb a ball of yarn. Paw pink (#F6B6B0) is too light for text on cream, so it fills selections and marks while links and buttons use a deeper paw pink (#A8463F). Cat can now be chosen in Settings. Chinese summary: 猫咪主题:奶油底、可可棕文字、橘色单线条线稿坐猫,线上缀着小光点;聆听时耳朵动、思考时尾巴摆、说话时光顺着轮廓流动;知识模式下线上光点是第一层,点开后像胡须一样拉出细线连到子项,白色圆角气泡带爪印;面板 20px 圆角、开关钮是爪印、滑块是毛线球;浅肉垫粉做文字对比度不够,文字和按钮用深一点的肉垫粉;设置里可以选择。

- Nature theme (ADR 0046 section 18): a misty night forest (#050806 to #0B1410, low mist and fireflies) with a tree made of gold light points and fine lines in the middle (gold branches, pale green canopy points, a glow at the roots). The whole tree sways with the voice while speaking, light climbs up the trunk while thinking, the canopy brightens and the fireflies gather while listening. In knowledge mode the branches are the categories and the leaves the contents: choosing a branch sends light along it to the tip, dims the rest of the tree and grows its children as leaves at the tip, with the same glass bubble and card as Tech. Panels are dark green frosted glass with serif titles, a warm gold accent and leaf-shaped slider and switch thumbs. Nature can now be chosen in Settings; text contrast is at least 4.5:1. Chinese summary: 自然主题:雾夜森林底、金色光点和细光线组成的树(枝干金色、树冠浅绿、根部微光、低处薄雾和萤火);说话时整树随音量轻摇、思考时光沿树干往上爬;知识模式下树枝是分类、叶子是内容,点树枝时光流到枝头、其他部分变暗,叶旁浮出玻璃气泡;暗绿毛玻璃面板、衬线标题、暖金强调色、叶形滑块和开关;设置里可以选择。

- Theme engine and the Tech theme (ADR 0046 section 16): a theme is now a set of tokens (colours plus radii, border width, shadows, display and numeric fonts, background texture, glow colour, and the shapes of switches, sliders, selects and segmented controls) and a hero drawn in code. The hero interface in `@fatcat-ai/ui` covers idle, listening, thinking, speaking with the voice level, and a knowledge mode; each theme brings its own implementation. Tech is the default: a ball of about 3,000 star points on pure black (white, pale violet and mint, a faint mint nebula inside, a few constellation lines near the edge), mint while listening, violet and slowly turning while thinking, points rising and falling with the voice while speaking; panels are dark glass with 1px lines and tabular numbers. Only Tech, Nature and Cat remain; the obsidian, light, follow-system and nebula options are gone, and any old stored value is shown as Tech without rewriting the saved settings (`theme` now also accepts `tech` / `nature` / `cat`; old values stay valid). Nature and Cat appear in the picker as coming soon until their own pull requests. Settings now has categories on the left and single-column groups on the right, with switches for every on/off option and one short hint only where an option needs it; the theme picker shows a small preview of each hero. On wide screens every page (Settings, Mail, Tasks, Plugins, Knowledge, Agents, Audit) opens inside the workbench with the same sidebar, search and panels. Hard-coded colours were removed from the maps (memory types and session roots / forks now come from theme tokens). The hero slows to about 15 frames per second while the window is in the background, stops while it is hidden, starts with fewer points on low-end machines and is a still picture with reduced motion. Chinese summary: 主题引擎与科技主题(token 覆盖颜色、圆角、边框、阴影、字体、底纹、光晕色和控件变体;packages/ui 定义主视觉接口:待机 / 聆听 / 思考 / 说话随音量 / 知识模式,各主题自己实现);科技为默认(纯黑底几千星点的球、内部淡青星云雾、边缘星座连线,深色毛玻璃面板与等宽数字);只保留科技 / 自然 / 猫咪,旧值一律按科技显示且不改写;设置页改为左侧分类 + 单列分组,主题选择带主视觉小预览;宽屏所有页面都在工作台里打开;地图颜色改用 token;窗口在后台降帧、隐藏时暂停、低端机减少星点、减少动态时为静态画面。

#### Changed

- New visual identity (ADR 0046, first of the M12 pull requests): the dark theme uses the new colour tokens (deep navy background, `#121216` surfaces, a single ice-cyan accent used only for selected items, status and primary buttons), now kept in one file, `@fatcat-ai/ui/tokens.css`; existing styles recolour through the old variable names. The light theme keeps the previous palette until light tokens are designed. The sidebar shows the logo, a line icon on each menu item and the assistant has a small paw avatar. A new app icon (a single-line cat paw, with a heavier small-size cut for 16 and 24 px) replaces the placeholder in the desktop installers, the tray, the favicon, the web app manifest and the PWA icons; all of them are generated from one SVG master by `node scripts/make-icons.mjs`. The desktop tray menu and error dialog are in Chinese by default and in English when the system language is English. The installer version now comes from `apps/desktop/package.json` (single source) and the release workflow fails if a `desktop-vX.Y.Z` tag does not match it. Chinese summary: 新视觉(深色新 token、只用冰青强调色、侧栏 logo 与单线图标、助手头像)、新应用图标(安装包、托盘、favicon、PWA 全部由一个 SVG 母版生成)、中文托盘、安装包版本以 apps/desktop/package.json 为唯一来源并在发布时与标签核对;浅色主题暂沿用旧色板。

### M11 · Mobile (in progress)

#### Fixed

- PWA service worker: the app shell and static files are now saved reliably. The worker used to copy a response into its cache after the page had started reading it, which could silently fail and leave nothing cached for offline use, and the write was not tied to the request so it could be cut short; the copy is now made first and the write is awaited. Chinese summary: 修复 service worker 缓存偶尔写不进去(先 clone 再写,并与请求绑定),离线打开更可靠。
- PWA service worker: opening `/offline.html`, an icon or the manifest directly no longer overwrites the saved app shell; the manifest and icons are fetched network-first so a changed icon or manifest reaches installed users; and the cache name now carries a build hash so each release drops the previous release's cached files. Chinese summary: 修复 PWA 缓存细节(直接打开离线页不再覆盖应用壳、manifest 与图标网络优先、缓存名带构建哈希,发布后清理旧文件)。

#### Added

- Offline reading (ADR 0045): the web UI keeps a read-only cache of your sessions and the most recent messages (200 per session) in the browser's IndexedDB, kept current in the background through `/sync`. If you open the app with no connection, a device that has signed in before shows the cached sessions and messages with the offline notice, and re-checks the sign-in when the network returns. Sending, deleting and everything else still needs a connection (nothing is queued). The cache and the remembered display settings are cleared on sign-out and whenever the server answers that the device is not signed in (for example after the device was revoked); a device that stays offline keeps its cache until then, so rely on the phone lock screen. if IndexedDB is unavailable (private mode) nothing changes except that there is no offline cache. Chinese summary: 新增离线只读:浏览器 IndexedDB 缓存会话和每个会话最近 200 条消息(通过 /sync 后台追平);断网打开时登录过的设备显示缓存和离线提示,联网后重新确认登录;写操作仍需联网、不排队;登出、或服务器答复未登录 / 设备已吊销时清空缓存(一直离线的设备仍保留,依赖手机锁屏)。
- Incremental sync (ADR 0045): `GET /api/v1/sync` returns the sessions, messages and items that changed since a cursor, with deletions as tombstones, so a phone can keep a small cache current without re-downloading everything (`client.sync()` in the SDK; `kinds` and `limit` narrow a batch, `hasMore` says to keep pulling). Without a cursor it returns a full snapshot, paged. It is backed by a change log kept up to date by database triggers, one row per session / message / item (so it never grows beyond the number of entities, even while a reply streams). Migration 0021 only adds the `change_log` table and triggers and fills the log from existing data; a backup is taken first as usual, and rollback is to restore that backup. Chinese summary: 新增增量同步 `GET /api/v1/sync`(游标、墓碑、kinds / limit、hasMore;SDK `client.sync()`);变更日志由触发器维护,每个实体一行;迁移 0021 只新增表与触发器并回填,迁移前自动备份。
- Phone pairing page (ADR 0045): open `/pair` on a phone (the QR code in Settings links to it with the code filled in), enter a device name and tap "Pair device". The browser then signs in with the device token instead of a cookie session, refreshes it quietly before it expires (safely across tabs, so a rotating refresh token is never replayed), and "Sign out" on the phone revokes that device. The WebSocket event stream now accepts device tokens (sent as a subprotocol, never in the URL), and the SDK can refresh an expired token and retry once. Revoking a device on the computer sends the phone back to the sign-in page. No database change. Chinese summary: 新增手机配对页 `/pair`(扫码带入配对码)、设备令牌登录并在过期前自动刷新(多标签页安全)、手机端退出即吊销;WebSocket 支持设备令牌(走子协议、不进地址栏);SDK 过期自动刷新重试一次;无数据库改动。
- Device pairing (ADR 0045): Settings has a new "Paired devices" section. "Add device" makes a one-time pairing code (shown as text and a QR code, valid for 5 minutes, works once); a phone or tablet exchanges it for a short-lived access token and a rotating refresh token, without typing the account password. Reusing an old refresh token revokes the whole device. Devices can be renamed and revoked (effective at once), and a paired device cannot create devices or access tokens, manage two-step verification, or change security settings. The SDK has `client.devices`, and pairing events go to their own `device_events` log. New database tables only (migration 0020, backup taken first as usual). The phone-side pairing page comes in a later pull request. Chinese summary: 新增设备配对:设置页「已配对设备」,一次性配对码(文字与二维码,5 分钟、一次有效)换设备令牌,refresh 每次轮换、重放即吊销设备,可改名吊销;设备令牌不能创建设备或令牌、不能改安全设置;迁移 0020 只新增表;手机端配对页随后提供。
- Web UI polish: on desktop widths the sidebar now keeps the full window height and stays put while the page on the right scrolls (it used to stretch with long pages such as Settings); the phone drawer is unchanged. The sign-in and first-run pages have a proper design: a centred card with the logo, a show/hide password button, a busy spinner on the submit button, a clearer error box and a hint that the setup code is the one-time code in the server startup log, in light and dark and on narrow screens. Authentication itself is unchanged. Chinese summary: 桌面宽度下侧边栏固定满高、不再随右侧长页面拉伸;登录 / 初始化页重做样式(居中卡片、密码显示切换、提交加载态、错误提示、设置码说明)。

- PWA shell (ADR 0045): the web UI can be installed from the browser ("Install app" button where the browser offers it) and has a web app manifest and icons. A service worker caches only the app shell and static assets, never anything under `/api/`, so the interface opens offline with an "offline" notice while conversations, mail and memory stay on the server. The server sends `Cache-Control: no-cache` for `sw.js`, the manifest and the offline page so updates are picked up. Voice recording now falls back to `audio/mp4` on Safari. Placeholder icons are used until real artwork exists. Chinese summary: 新增 PWA 外壳(可安装、离线打开界面并提示、service worker 绝不缓存 API 响应、Safari 录音回退 mp4);图标为占位。

### M10 · Desktop app (in progress)

#### Fixed

- Windows desktop launch (found on a real Windows 11 machine): the installed app exited at once (code 101) because Tauri's resource path carries a `\\?\` prefix that Node rejects; the prefix is now removed. The core service no longer opens a console window, its output goes to `logs\sidecar.log` in the data directory, and a failed start shows an error box with that path instead of dying silently. The release workflow now installs the Windows installer into a folder with spaces and Chinese characters, starts it without any override variables, checks `/healthz`, checks there is no console window, and checks the service exits when the shell is killed. The desktop guide notes the WebView2 cache location. Signing private keys stay on the owner's machine: docs say so and CI (`pnpm check:workflow-secrets`) fails if a workflow references a `*PRIVATE_KEY*` secret. Chinese summary: 修复 Windows 桌面版装完即闪退(路径前缀)、弹控制台窗口、失败无提示;发布工作流新增 Windows 安装冒烟;私钥只留本机并由 CI 检查。

#### Added

- Desktop installers (ADR 0044): a `Desktop release` workflow builds unsigned installers for Windows, macOS and Linux (with a pinned, checksum-verified Node inside), fails if any installer is over 80 MB, publishes SHA-256 sums with a keyless cosign signature, and only runs when started by hand or by a `desktop-v*` tag. CI also runs `cargo deny` (permissive licences only, no telemetry crates). The Linux `.deb` built here is 52 MB. A desktop installation guide (zh/en) is on the docs site, and `docs/milestones/M10-self-check.md` lists what is verified and what the owner still has to check. Auto-update, notifications, file drop and the remote mode are not included yet. Chinese summary: 新增三平台桌面安装包的发布工作流(体积上限、SHA-256、cosign 签名、cargo deny)、桌面安装指南和 M10 自检;自动更新等待业主生成密钥。
- Memory map and session map (ADR 0044): the Memory page has a "Memory map" that groups memories by type with colour, brightness from confidence and tier, and a red outline for unresolved conflicts; clicking a point jumps to its card. A new session map page (open it from the knowledge map) draws forked sessions as a tree, opens a session, jumps to the message where a fork started, and finds the session in the knowledge map. Forking itself is not in the app yet, so the session map shows an empty state until it is. Chinese summary: 记忆页新增记忆地图(按类型着色、亮度表示置信度与分层、冲突描边),新增会话地图页(分叉关系、定位分叉点、与知识地图互跳);应用里暂时还不能创建分叉。
- Knowledge sphere (ADR 0044): the knowledge map has a new "Sphere" view next to the list. The entries of the current category float on a sphere you can drag to rotate; click selects, double-click or Enter opens (drills into a category or shows the content), arrow keys move the selection and Esc goes up one level. Categories are orange and sized by how much they contain, content is blue. Without canvas support, or when "reduce motion" is on, the list is used automatically. A synthetic 10,000-point layer draws in about 2 ms per frame in headless Chromium. Chinese summary: 知识地图新增粒子球视图(拖动旋转、点击选中、双击 / 回车下钻、Esc 返回、方向键切换),无 Canvas 或开启减少动态效果时自动用列表。
- Desktop native features, first part (ADR 0044): the global shortcut `Ctrl+Shift+Space` brings the window forward and focuses the message box, the tray menu has a "Start at login" switch, only one app instance runs, and the links `fatcat-ai://chat/<id>` and `fatcat-ai://ask?text=...` open a conversation or pre-fill the message box (never sent automatically; any other link is ignored). The page loaded in the window gets no Tauri permissions. Notifications, file drop and local/remote switching wait for a design of the page-to-shell bridge. Chinese summary: 桌面端新增全局快捷键、开机自启开关、单实例和白名单深链接(只预填、不自动发送);通知、拖拽与远程模式切换待桥接方案。
- Desktop shell skeleton (ADR 0044): `apps/desktop/src-tauri` is a Tauri v2 app that starts the server as a sidecar on a random loopback port, waits for `/healthz`, opens it in a window, keeps running in the tray when the window is closed, and quits from the tray menu. If the shell dies, the sidecar exits on its own. It is not an installer yet (packaging comes with the release PR) and it does not sign you in automatically; you sign in on the normal page. Chinese summary: 新增 Tauri 桌面壳骨架(随机端口启动核心、托盘驻留、壳崩溃后核心自动退出),尚未打包安装包。
- Desktop sidecar packaging (ADR 0044, first part): `apps/desktop` can bundle the server into a few single files plus the platform's SQLite prebuild, and a smoke script starts it and checks `/healthz` (about 240 ms here) and that it exits when the parent closes its stdin (`FATCAT_AI_EXIT_WITH_PARENT=1`). CI runs this check on Linux. Chinese summary: 新增桌面 sidecar 打包与冒烟检查,核心可随桌面壳退出。

### M9 · Internationalization and docs site (in progress)

#### Added

- `@fatcat-ai/i18n` (ADR 0043, first part): the Web UI dictionaries now live in one package with a small message format (`{name}`, `plural`, `select`), locale-aware dates and numbers, locale resolution (setting, then browser language, then English) and per-language templates for the short texts the server puts into prompts and status labels. `pnpm check:i18n` (also in CI) fails on hard-coded Chinese or English text in the Web UI; a unit test checks that both languages have the same keys and placeholders. A guide for adding a language is in `docs/contributing/translations.md`. Chinese summary: 界面文案迁到 `@fatcat-ai/i18n`,日期按所选语言显示,新增 `pnpm check:i18n` 防止硬编码文案,并附新增语言的流程文档(待校对)。

- Docs site (ADR 0043, second part): `apps/docs` is an Astro Starlight site in Chinese (root) and English (`/en/`) with built-in Pagefind search: quick start, configuring models (with common providers), security, FAQ, and the Docker deployment guide (synced from `docs/deploy/` so there is a single source). The `Docs` workflow builds it on every relevant PR, checks internal links, zh/en page parity and the search index, and publishes to GitHub Pages after a merge to `main` (the repository owner has to enable Pages with Source: GitHub Actions first). The build turns Astro's own usage statistics off and does not use `sharp` (its libvips is LGPL). Chinese summary: 新增中英双语文档站(Starlight,自带搜索),含快速开始、配置模型、安全说明、FAQ 与 Docker 部署指南;合并后自动发布到 GitHub Pages(需业主先启用 Pages)。

- Docs site content (ADR 0043, third part): guides for connecting WeChat and for developing plugins (synced from `docs/plugins/`), an API reference generated from `apps/server/openapi/v1.json`, an ADR index, and the changelog, all in both languages. Relative links in synced documents are rewritten to site pages or GitHub files. The self-check is `docs/milestones/M9-self-check.md`. Chinese summary: 文档站补全:接入微信、插件开发指南、由 OpenAPI 生成的 API 参考、ADR 汇总和更新日志,中英文齐全。

#### Fixed

- Dates and times in the mail pages and the approval countdown ignored the language chosen in Settings; they now follow it. The footer's source link text, the mail provider names and setup hints, and the names of the built-in top-level categories in the knowledge map (Sessions, Novels, Files, Characters) are now translated; with English selected no Chinese text is left on any page except names that were stored in the database earlier (such as the built-in agent roles).

### M8 · Multi-agent

#### Added

- Agents (ADR 0042, first part): an agent is a saved persona with its own system prompt, model profile, tool set and memory setting. `GET/POST /agents`, `GET/PATCH/DELETE /agents/{id}` and `POST /agents/{id}/copy` manage them; four read-only built-in roles (researcher, mail secretary, file keeper, schedule assistant) are created on first use and can be copied and edited. Send a message with `agentId` to run it as that agent; if you do not, nothing changes. An agent's tool set (same syntax as a task's `toolSet`: exact names or prefixes ending in `.`) decides which tools the model is shown, and a call to a tool outside it is refused as an unknown tool and never runs; approvals and pre-authorizations work exactly as before. The model profile is taken from the request first, then the agent, then the session. Memory setting `none` turns off memory recall and hides the `memory.` tools for that agent; `maxSteps` limits the tool steps of a run. Retry and regenerate keep the agent of the original run. Runs record their `agentId`. The client has `client.agents`. The web page for agents comes in a later M8 change.
- Delegation (ADR 0042, second part): an agent whose tool set lists `delegate` can hand a self-contained task to another agent by name and get its final answer back; several `delegate` calls in one step run in parallel (up to 3 per run). A sub-agent only gets the tools that both its own set and the delegating agent's set allow, a call outside that is refused and audited as denied, and a sub-agent does not get `delegate` unless you add it (limited by `maxDepth`). A sub-agent's approvals work exactly as before, with the card saying which agent asked. `budgetTokens` and `budgetSeconds` are shared along the delegation tree and stop it first-come first-served; the sub-agent returns what it has with `stopped: "budget"`. Its output is treated as untrusted content. Each delegation is recorded as a run with `parentRunId`. Plain chats, tasks and the built-in roles have no `delegate`, so nothing changes unless you create an agent that lists it.
- Agents in the web app and CLI (ADR 0042, third part): an "Agents" page lists the built-in roles and your own agents, lets you create, edit, copy and delete them (tool set, memory setting, model, depth, steps and token / time budgets), and the chat has an agent picker next to the message box (remembered in this browser; "No agent" behaves exactly as before). A message that used `delegate` shows the delegation tree below it with each sub-agent's status, refreshed while it runs. New `GET /runs/{id}/tree` returns a run and everything it delegated; cancelling a sub-run cancels the whole tree, and a sub-run cannot be retried on its own. `fatcat-ai agents list|show` in the CLI. Resuming interrupted delegations after a restart is not part of this change.
- Multi-agent evaluation (M8 acceptance): three scripted cases are part of `pnpm eval`: "research X and write a report to the Reports folder" (a lead agent delegates to two sub-agents in parallel, then writes the file after you approve), a fully manipulated sub-agent trying tools outside its set (file write, mail send, memory write, re-delegation: none runs, all are audited as denied), and instructions hidden in a sub-agent's answer (they cannot bypass approval or the authorized folders). M8 self-check report added.
- Database migration 0019 for agents (ADR 0042 section 6): table `agents` plus nullable columns `runs.agent_id` and `runs.parent_run_id`. Existing tables and data are untouched, nothing changes for chats that do not use an agent, and the usual automatic backup is taken before the migration runs. Older versions cannot open a migrated database (they refuse to start with "unknown to this version"); to roll back, stop the server, restore `backups/db-…-pre-0019.sqlite` and run the older version. Data written after that backup is lost.

### M7 · Plugins (in progress)

#### Added

- CLI plugin market, upgrade and rollback: `fatcat-ai plugins market [--refresh]` lists the signed index; `plugins install --market <market-id> <plugin-id> [--version <v>]` installs from the market; `plugins install` now also upgrades an installed plugin (it prints the new and removed permissions and the backup note first, and asks before doing anything; over 500 MiB of plugin data needs an explicit `--skip-backup`); `plugins rollback <id>` goes back to the previous version. All of it uses the public API; no server change.
- `scripts/plugins/pack-plugin.mjs`: packs a plugin folder into the market's `.tgz` using only Node built-ins. The output is byte-for-byte reproducible (sorted entries, fixed time, owner and mode, fixed gzip header), long paths use the ustar prefix field or the script stops (no pax or GNU long names), and links, junctions, hard links and `node_modules` are refused. The result is unpacked and checked with the client's own tar reader, manifest check and the index static scan before the file is written; it prints the size, the sha256 and a draft `index.json` version entry. Steps for packing `examples/plugins/hello` into one file are in `scripts/plugins/README.md`.
- `@fatcat-ai/shared` and `@fatcat-ai/plugin-sdk` are now publishable (`0.1.0`, `publishConfig.access: public`, `files` has `dist`, `LICENSE` and `README.md`; `pnpm pack` leaves no `workspace:*`). Nothing is published; the owner's steps are in `docs/plugins/publishing-sdk.md`.
- Plugin development guide (`docs/plugins/developing-plugins.md`, with a Chinese version; the English text is waiting for a native-speaker review) and the M7 self-check report (`docs/milestones/M7-self-check.md`).
- Plugin upgrade and rollback (ADR 0040 section 6.2): preparing a package whose version is higher than the installed one (from a local folder or the Market tab) turns the install dialog into an upgrade dialog that lists the permission changes: new tools, a tool's level going up, a tool starting to send data out, new domains, secrets and item categories need your approval, and permissions that went away are listed too. The old version keeps running until you confirm. Upgrading backs up `plugin-data/<id>/` (not above 500 MiB: then you must explicitly choose to upgrade without a backup), starts the new version and runs a health check (handshake, `tools/list`, every declared tool present); if it fails the old version, its data and its state are put back and the reason is recorded. Pre-authorizations for tools whose level went up, that started sending data, or that were removed are revoked and audited. The previous version's code and data backup are kept (one each), and `POST /plugins/{id}/rollback` (the "Roll back" button) restores them. A plugin whose `engines.fatcat` no longer matches the core is marked `incompatible` at startup and not started; installing a compatible version fixes it. New error codes `plugin_upgrade_failed`, `plugin_backup_too_large`, `plugin_network_unsupported`. No database migration.
- Plugins from a local folder that declare network access are refused on platforms without operating-system network isolation (for example Windows); install them from the reviewed market instead, or drop the `net` permission.
- Plugin market (ADR 0040 sections 5.2 and 5.3): the Plugins page has a Market tab. Opening it downloads the signed plugin index once (a single GET with no identifiers; after that only when you press Refresh) and shows the plugins in it; "Review permissions and install" downloads the package, checks it and shows the same permission and protection-level screen as a local install before anything is installed. The index is verified with Ed25519 (two public keys are built in, the main and the backup key; an index signed by either is accepted), a new index must not have a lower `serial` than the cached one and must not be expired, and every package is checked against the size and SHA-256 in the signed index. Packages are unpacked by a built-in tar reader that rejects symbolic links, `..`, drive letters, reserved Windows names, case-only duplicates and decompression bombs; downloads only follow `https:` to hosts listed in the index, with the same address checks (and the fake-IP setting) as `web.fetch`. If an update fails or is rejected, the cached index stays in use and the page says why; an expired cache cannot install. A version withdrawn by the market is hidden and cannot be installed, and an installed one shows a warning (it is not removed). Settings has a switch to turn the market off (no index is downloaded, no market address in the egress list). `scripts/plugins/` holds the index repository's CI checks and the owner-side signing script (see its README). API additions: `GET /plugins/market`, `POST /plugins/market/refresh`, `source: { kind: 'market', ... }` on `POST /plugins/prepare`, and the error codes `market_disabled`, `market_unavailable`, `plugin_download_failed`, `plugin_too_large`, `plugin_checksum_mismatch`, `plugin_manifest_mismatch`, `plugin_yanked`. A checksum and a signature only show that the package is the one that was reviewed, not that the reviewer approved a harmless one.
- Plugin secret bindings can be removed: clearing a bound secret and saving unbinds it, and unbinding a required secret also disables the plugin.
- Plugin capabilities (ADR 0040 section 3.3): `fatcat/net.fetch` sends a plugin's HTTPS request through the server, limited to the domains the plugin was granted and to the same address checks as `web.fetch` (private, loopback, metadata and fake-IP addresses, every redirect hop re-checked, 30 s timeout, 2 MiB body, no cookies); denied calls are recorded as `denied` plugin events. Plugins can add their own categories to the knowledge map: the server pulls `roots`/`children` when it syncs and calls `open` when you open an item, and plugins can push items with `fatcat/items.upsert` (at most 50,000 items per plugin, 8 KiB of `meta` per item, only under categories the plugin declared); uninstalling removes the plugin's items. Plugin settings are now passed to the plugin when it starts (`FATCAT_PLUGIN_SETTINGS`, `ctx.settings` in the SDK) and restart it when changed. A plugin's task templates can be turned into task drafts from the plugin page; the draft only runs after you confirm it on the Tasks page, and uninstalling the plugin disables the tasks created from its templates. `examples/plugins/hello` now shows all of this.
- Plugins page in the web UI (ADR 0040 section 9) and `fatcat-ai plugins list|install|stop|remove` in the CLI. Installing from a local folder first copies and checks the package without running it, then shows the requested permissions and the protection-level table for this platform; nothing is installed until you accept all of it. Installed plugins can be enabled, disabled and stopped, get a settings form rendered from the manifest's `settings` (now validated by the server), `env:` secret bindings, optional memory settings and the latest memory reading, and an uninstall dialog that lists the tasks it will disable and warns that plugin data is not in the automatic backups. The tasks page shows why a task was disabled when its plugin was uninstalled. API additions: `settingsSchema` on plugins, `protections` on the plugin detail, `disabledReason` on tasks.
- The plugin network-isolation probe now runs asynchronously (no event-loop stall on first use) and, on macOS, proves the sandbox by letting a sandboxed child try to connect to a local port. Not yet verified on a real Mac.
- Plugin manifest contract (ADR 0040): the `plugin.json` schema, the market index schema, the `engines.fatcat` version-range check and the `fatcat/*` extension messages now live in `@fatcat-ai/shared`, so the server, the SDK and the index repository share one validator. Unknown fields, `dangerous` tools, `broad` domains, `FATCAT_AI_*` secret names and non-free licensing are rejected. Nothing is installable yet; the runtime and UI come in later M7 changes.
- `@fatcat-ai/plugin-sdk` (Apache-2.0, not published to npm yet): `definePlugin`, `registerTool`, `registerItemProvider`, `ctx.fetch`, `ctx.log` and a built-in minimal stdio MCP server with a 30-second heartbeat. The example plugin `examples/plugins/hello` also works as an ordinary MCP server.
- Database migration 0018 for plugins (ADR 0040 section 7): tables `plugins` and `plugin_events` plus a nullable `tasks.disabled_reason` column, with matching storage repositories. Existing tables and data are untouched, nothing reads the new tables yet, and the usual automatic backup is taken before the migration runs. Older versions cannot open a migrated database (they refuse to start with "unknown to this version"); to roll back, stop the server, restore `backups/db-…-pre-0018.sqlite` and run the older version. Data written after that backup is lost.

#### Changed

- The index static scan (`check-index.mjs`) now only flags code that loads a refused built-in module (`import`, `import()`, `require`, `createRequire`, `getBuiltinModule`, with or without `node:` and `/promises`), not module names inside ordinary strings, so a bundled plugin that includes `@fatcat-ai/shared` is no longer rejected. The checks for `process.binding`, `process.dlopen`, `eval` and `new Function` are unchanged. The scan's range and limits are written down in `scripts/plugins/README.md` and ADR 0040 section 3.4.
- `sign-index.mjs --verify` now works in CI (it only uses the built-in public keys and refuses `--key`, `--key-id` and `--allow-unknown-key-id`); signing is still refused in CI. The index repository workflow calls it directly. After this is merged the owner should move `FATCAT_AI_REF` in the index repository to the new commit.
- The plugin install page no longer says that brokered network requests and the knowledge-map item quota "arrive in a later release": both are implemented and shown as enforced (allowed domains only, same address checks as `web.fetch`, 2 MiB; at most 50,000 items per plugin).
- Plugin development guide: tool levels follow the runtime rule (a `net` permission raises `read` to `write`; only `sendsData` makes a tool `external`), the 500 MiB upgrade-backup exception, the reserved `AIP_` secret prefix, the packing steps, and the Chinese and English texts now follow the same paragraphs.

#### Fixed

- The server now handles `SIGBREAK` on Windows, releases `server.lock` synchronously on exit, forces the exit (and releases the lock) if a graceful shutdown hangs, and exits at once on a second Ctrl+C. A lock left behind by a process that was killed outright is recognized as stale at the next start, as before.
- Plugin settings validation no longer treats names on the object prototype (`constructor`, `toString`, `__proto__`) as declared settings. A host name that resolves to no address is reported to a plugin as a failed request, not as a denied one.

### Memory

- Memory is now measured and reported, not gated (ADR 0041, which supersedes ADR 0018). CI no longer fails on idle memory, memory rollback after load or channel increments; the numbers are still written to the job summary. The README and the Docker guide no longer promise a 2 GB server; 2 GB is only a suggestion. `.github/memory-baseline.json` is kept as recorded reference values.

### Renamed to FatCat-AI

The project was renamed from AI-Personal to FatCat-AI and moved to <https://github.com/CodingLossy/FatCat-AI> (ADR 0019).

#### Changed

- Packages are now `@fatcat-ai/*`, the CLI command is `fatcat-ai`, and the Docker image is `fatcat-ai`. The client SDK exports `FatCatClient`, `FatCatApiError` and `FatCatNetworkError`.
- The default data directory is `~/.fatcat-ai`. On the first start, the server moves an existing `~/.ai-personal` there (a rename, or a verified copy across drives); it never overwrites an existing `~/.fatcat-ai`. Docker keeps `/data` and the `ai-personal-data` volume.
- The docker compose service is now `fatcat-ai` instead of `ai-personal`. If you already run it with compose, run `docker compose -f docker/docker-compose.yml down` with the old compose file before upgrading, or start the new version with `docker compose -f docker/docker-compose.yml up -d --build --remove-orphans`; otherwise the old container keeps holding port 8787. Your data stays in the same volume.
- If the old server is still running on Windows, the data directory can't be moved (`EPERM` / `EBUSY`). The server retries for a few seconds, then exits with a message asking you to stop the old AI-Personal server first; nothing is moved or deleted.
- Environment variables now start with `FATCAT_AI_` instead of `AIP_` (for example `FATCAT_AI_PORT`, `FATCAT_AI_DATA_DIR`, `FATCAT_AI_TOKEN`). The old names still work for now and print a deprecation warning.
- Unchanged on purpose: the `aip_pat_` token prefix, the `aip_session` / `aip_csrf` cookies and the `X-AIP-Server-Version` header, so existing tokens and API v1 clients keep working.

### M6 · Scheduled tasks and automation (in progress)

#### Added

- General task scheduler (ADR 0033, migration 0016): tasks and run records are stored in the database, scheduled in your time zone, and kept across restarts. Each run is recorded with its status, error code and times only (no content). Failed runs retry after 1, 5 and 15 minutes; runs missed while the server was off are skipped or caught up once, per task; tasks can have quiet hours; at most two tasks run at once. The memory maintenance (decay, tiering, expiry) now runs as the built-in system task "Memory maintenance" and can be disabled, run now, or moved to another time. New Web page "Tasks" and `/api/v1/tasks` endpoints (also in the client SDK). Event triggers and natural-language creation come in later M6 changes.
- Your own tasks (ADR 0034): a task hands a prompt to the assistant on a schedule and runs unattended in its own conversation. Anything that needs approval still waits for you and is refused if nobody answers within 30 minutes. A task can push its result to your own WeChat channel; every push needs your approval and cannot be pre-authorized, and the model cannot choose the target. An optional per-task allow-list lets read/write tools run without asking (empty by default; tools that send or run things outside this machine can never be on it).
- Event triggers for tasks (ADR 0035, migration 0017): run a task when new mail arrives (it only learns how many), when files change in an authorized directory (5 s debounce), or when a webhook is called with a per-task token (only a hash is stored; wrong or missing tokens all get the same 401). Events run a task at most 12 times per hour, are ignored while the task is already running, and what they carry reaches the assistant only as untrusted data.
- Create a task from one sentence (ADR 0036): type e.g. "every day at 8 am summarize my unread mail" on the Tasks page; the model only produces a draft, shown as a card. A draft never runs: nothing happens until you press "Confirm and enable" in a logged-in browser session (access tokens cannot confirm). The sentence can never add an allow-list or choose where results are sent; a push only goes to your own bound channel and still needs approval each time.
- Task page fixes after real-device testing (ADR 0036): warnings and errors on the task page (including the confirmation card and the "missing time or action" hint) are now translated through the Chinese/English dictionaries. Cards and the task list show the task time zone (e.g. `0 8 * * * (time zone America/Los_Angeles)`), "next run" is shown in the task time zone, and your local time is added when your browser is in another zone. The one-sentence parser now knows that a new-mail trigger only provides the number of new messages, so generated prompts no longer ask for sender, subject or summary, and the card says so. API: `ProblemDetails.reason`, `Task.timeZone`, and `notes` / `timeZone` on the draft response (all optional additions).
- Memory consolidation (ADR 0037, off by default): an optional daily system task (04:00) merges three or more scattered memories on the same topic into one higher-level memory. The originals are kept; credentials are still refused and instruction-like text goes to quarantine. At most 10 model calls and 20 new memories per run, once a day. Turn it on in the Tasks page.

#### Fixed

- Pre-authorized domains (ADR 0039): the task pre-authorization form now explains the matching rule (`example.com` matches only itself; `*.example.com` matches every subdomain but not `example.com`), offers to add `www.` or `*.` when you enter a bare domain, accepts several domains separated by commas, and reports a protocol, path, port or over-broad wildcard (`*.com`) in Chinese before saving. Stored pre-authorizations that lack the required domain are no longer honored.
- File-change triggers: on Windows, deleting the watched directory made `fs.watch` fire endlessly and spin the CPU. The watcher now notices the directory is gone, stops, and logs one error. A task whose authorized directory was revoked now shows a warning on the Tasks page; authorizing the same folder again creates a new id, so pick the directory again in the task.
- Missed runs are recorded once: with the "skip" policy (and for catch-ups older than 24 hours, including the built-in memory sleep task) a restart no longer adds the same "missed" row again.
- Throttled event runs are recorded as `event` instead of `schedule`; when memory consolidation has used up today's quota, a manual run is recorded as skipped with the reason "Today's quota is used up".
- File-change triggers: when the watched folder is deleted on disk but still authorized, the task now shows a "folder missing, watching paused" warning (`root_missing`), and watching resumes within about a minute after the folder is recreated, without restarting the server.
- Secrets: the `backups/` directory itself is now restricted to the current user (Windows ACL, `chmod 700` elsewhere) when a secrets backup is made, not only the files inside it.

### M5c · Release prep (in progress)

#### Added

- Release preparation (ADR 0032). `.github/workflows/release.yml` builds the Docker image for `linux/amd64` and `linux/arm64` (each on a native runner, with a health check) on pull requests that touch the Dockerfile and on manual runs, and **pushes nothing by default**: only a `v*` tag or a manual run with `push` ticked publishes to GHCR (a manual run only gets the `sha-<7>` tag). Tag policy and the check that nothing was published are in `docs/release/image-tags.md` and `scripts/check-no-release.mjs`. A v1.0 release notes draft is in `docs/release/` (English pending proofreading; the recommended model combination is left blank for the owner). The README quick start now starts with Docker. `scripts/perf/chat-peak.mjs` measures the chat-time memory peak in the image. No tag, release or image has been published.
- Docker deployment guide for a 2 GB machine (`docs/deploy/docker.md`, English version pending proofreading): `docker/docker-compose.prod.yml` runs the app plus Caddy with automatic HTTPS (only Caddy publishes ports, 512 MiB app limit, master key from a Docker secret file), `docker/caddy/Caddyfile.example`, and an optional DNS-01 variant for DNSPod (Tencent Cloud DNS) built with a pinned community plugin (an example, not a project dependency). Includes hardening before going public, backup and restore, upgrade and troubleshooting. ADR 0031 records the reverse-proxy responsibilities and one known limitation: behind a proxy the login failure limiter counts all visitors as one source. A CI deployment smoke runs the production compose with an HTTP-only Caddy and checks `/healthz`, the setup code, WebSocket and chunk-by-chunk SSE without touching the internet.

#### Changed

- The mobile drawer now also closes when you tap the link to the page you are already on, moves focus into the drawer when it opens and back to the Menu button when it closes with Esc or a tap outside; in Mail, "Back to list" returns focus to the message you had open.
- The Web UI now works on phone-sized screens (360 px and up, portrait and landscape). Below 720 px the sidebar becomes a drawer opened from a top bar (closed by a tap outside, Esc, or navigating); controls are at least 44 px tall and inputs use 16 px text so iOS does not zoom on focus; Mail shows the list and the open message as two screens with a "Back to list" button; the audit table scrolls inside its own container; the composer sticks to the bottom and respects safe areas. The page has `viewport-fit=cover` and a `theme-color`. No API changes. Real-device behaviour (iOS Safari, Android Chrome soft keyboard) is not verified yet.

### M5b · Secrets, TOTP and the knowledge map (in progress)

#### Added

- Secrets encryption (ADR 0026). `secrets.yaml` can now be encrypted as a whole into `secrets.yaml.enc` (AES-256-GCM, envelope `fcsec1`). It is never done automatically: use Settings → Secrets (status, master key source and fingerprint, a confirmation step, and what to do with existing plaintext backups: keep, encrypt or delete) or the offline commands `node dist/index.js secrets migrate`, `secrets rekey --new-key-file <file>` and `secrets cleanup`. Migration backs up, writes and verifies the encrypted file, and only then renames the plaintext file to `secrets.yaml.migrated`; any failure leaves the plaintext untouched. The master key comes from `FATCAT_MASTER_KEY`, `FATCAT_MASTER_KEY_FILE` or a generated `master.key` (mode 600). A fresh install writes the encrypted file from the first secret on. If the master key is missing or does not match, the server still starts and features that need secrets report "密钥不可用" without any file being changed. `master.key`, `secrets.yaml.enc` and `secrets.yaml.migrated` are never committed (`pnpm check:secrets`).
- API: `GET /api/v1/settings/secrets` and `POST /api/v1/settings/secrets/migrate` (body `confirm: true`, optional `plaintextBackups`: `keep`, `encrypt` or `delete`); neither returns any secret value. Both additive.
- Egress target list (ADR 0028). Settings → Egress targets shows, read-only and grouped by category, every address this server may connect to under the current configuration: chat, embedding and voice model profiles, mail accounts (IMAP and SMTP), WeChat channels (disabled ones are listed as disabled) and MCP servers (a stdio server is shown as a local process; its own network access is not covered). Only `scheme://host[:port]` is shown, never paths, query strings, credentials or secret references. Network tools you approve call by call (such as `web.fetch`) go wherever the conversation says and are not listed. The list is computed from the configuration, with no migration and no new dependency. A new CI check, `pnpm check:egress`, fails when production code uses a network API in a file that is not in `scripts/egress-registry.json`.
- API: `GET /api/v1/settings/egress-targets` (login required, read-only); additive.
- Two-step verification with TOTP (ADR 0027). Settings → Security turns it on: enter your password, scan the QR code with an authenticator app (RFC 6238: SHA-1, 6 digits, 30 seconds, one step of clock drift either way), confirm with a code, and save the 10 one-time recovery codes, which are shown only once. Turning it on signs out every other session; your current browser stays signed in. Once on, signing in needs the password and a code (or a recovery code); a code works once per time step; five wrong codes cancel the sign-in attempt, and failed attempts are rate limited per user name and per IP address. The shared secret is stored encrypted with the master key from ADR 0026 (if that key is unavailable, sign-in with a code fails instead of being skipped), and recovery codes are stored only as salted hashes. Existing personal access tokens keep working; with TOTP on, creating a new token needs a browser session that passed the second factor, and tokens cannot manage TOTP. If you lose both the code and the recovery codes, run `node dist/index.js auth reset-totp` on the server machine: it removes the TOTP data, signs every session out and writes an audit entry. `secrets rekey` now also re-encrypts the stored secret in the same database transaction. The command-line client asks for the code when it signs in. Database migration 0015 adds two tables and one column and changes no existing data (the usual backup runs first).
- API (additive): `POST /api/v1/auth/login` can now answer `202` with a `LoginChallenge` (no session cookie) for accounts with TOTP; accounts without TOTP get exactly the same `200` as before. New: `POST /api/v1/auth/login/totp`, `GET /api/v1/auth/totp`, `POST /api/v1/auth/totp/setup`, `enable`, `disable` and `recovery-codes`. Responses carry `Cache-Control: no-store`.
- People in the knowledge map (ADR 0029). A new top-level category "People" lists the contacts found in your synced mail: everyone you have sent mail to (To and Cc), plus senders who wrote to you at least twice. Your own addresses, obvious system senders (`noreply`, `no-reply`, `donotreply`, `do-not-reply`, `mailer-daemon`, `postmaster`, `notification(s)`) are left out. Each person shows a name (the latest non-empty display name, cleaned of control characters), the address, the mail count and the last contact time, and links to their 200 most recent e-mails. Only the From, To and Cc headers are read, never the message body. Mail with a `List-Id` header is not excluded yet, because the local mail cache does not store that header; this needs a database migration and is left for a later change.
- Category browser for the knowledge map (ADR 0029). The knowledge map page is now a browser with a lazy-loaded tree (children are requested when you expand a node), a right-hand list with virtual scrolling, cursor paging and sorting by position, title or update time, a type filter, a breadcrumb, and search inside the current category. Opening a leaf shows its text and, for a person or mail, the "also appears in" links. "Ask AI" starts a session about one item or a whole category and pre-fills the input box without sending it; the item titles and summaries in that prompt are cleaned, truncated and wrapped as untrusted data, and the session counts as having read untrusted content when mail or contacts are involved. On a phone the tree moves into a drawer. No migration and no new dependency (the list window is computed in `@fatcat-ai/ui`).
- API (additive): `POST /api/v1/items/{id}/ask` (body `scope`: `item` or `subtree`; login and CSRF required; answers `201` with `sessionId`, `prompt`, `untrustedContentSeen`, `truncated`). The item read endpoints (`roots`, `search`, `{id}`, `children`, `ancestors`, `counts`, `subtree`, `related`) now send a weak `ETag` and answer `304` to a matching `If-None-Match`; responses without that header are unchanged. The client SDK gets `items.ask`.
- API: `GET /api/v1/items/{id}/related` returns the non-primary links of an item (outgoing and incoming, for example a person's mails and a mail's people), cursor-paginated with an optional `rel` filter. Login required, read-only; additive. The client SDK has `items.related`. Links do not change item counts. No migration.
- IM `/map` command (ADR 0029). Send `/map` to your bound WeChat to browse the knowledge map: reply with a number (1–9) to open an entry, `0` or 返回 to go up, 下一页 / 上一页 to page, `/map` again to start over. Only titles and counts are shown; a leaf shows its title, type and a short summary, never the body (open it on the Web). A reply only counts when the whole message is just that number or word, within 5 minutes of the last `/map` reply, and is not quoting anything; anything else is normal chat. `/map` replies are not added to the conversation. It reads only your own items, and counts toward the 20 messages a minute like `/new` and `/help`.

#### Fixed

- Two-step verification no longer allows endless guessing: failed codes are now counted per user name and per IP over 24 hours, and lock for 15 minutes after 10 failures, 1 hour after 20, then twice as long every 10 more (up to 24 hours). Only a successful verification resets the count, and a correct code is refused during a lock. Each lock writes a warning to the log. Concurrent requests can no longer each get a guess in before the first failure is counted (also for sign-in with a password). (Reported in the review of #35.)
- `secrets rekey` now re-encrypts every encrypted backup in `backups/` with the new key, checks each one by reading it back, and puts everything back if any step fails. It also works when `secrets.yaml` is still plaintext but TOTP is on (only the TOTP secret in the database is re-encrypted). `secrets migrate` and `secrets rekey` refuse to run while the server is running (the server writes `server.lock` in the data directory). With `--plaintext-backups delete` the printed backup name is the rollback copy `secrets.yaml.migrated`; encrypted backups are pruned to the newest 5 by timestamp. `GET /api/v1/settings/secrets` answers 409 with a remedy, not 500, when both `secrets.yaml` and `secrets.yaml.enc` exist. (Review of #32.)
- `pnpm check:egress` now also catches `import https from 'https'`, `node:http2`, `require('net')`, `fetch` passed or assigned without a call, and the `ws`, `node-fetch`, `axios`, `got` libraries and MCP SDK sse / streamableHttp clients. The memory gate (ADR 0018 rule 4) now also fails a slow leak that grows a few MiB on every run. (Review of #34 and #36.)

### M5a · Channels (in progress)

#### Added

- Chat: when memory recall was incomplete, the "Memories used this turn" panel now says so, even if no memory was used. For example: "Vector search timed out; this turn used only full-text and linked search, so relevant memories may be missing." If the embedding key looks invalid or the endpoint rejected the request, the note links to Settings. When some relevant memories didn't fit the memory budget, the panel shows how many (ADR 0017).
- API: the `memory-used` event has optional `degraded` (`[{ path, reason }]`, reason `timeout`, `auth`, `rejected` or `error`) and `omitted` fields, and `POST /api/v1/memory/retrieve` returns `degraded`. When recall was incomplete, `memory-used` is sent even with an empty `ids`. Not having an embedding profile is not counted as incomplete. All changes are additive.
- The server writes a local `memory.retrieve.degraded` log line with the path, reason, time taken, run id and (for embedding errors) the HTTP status code only; no query text, memory content or error text.
- Settings → General: a searchable time zone setting (ADR 0023). Left empty, FatCat-AI follows the server's time zone, which the page shows. "Today" in the mail tools, the default time zone of the `time` tool, the daily 03:30 memory maintenance and attachment cleanup, and the daily embedding and auto-extraction limits now use your time zone instead of the server's (Docker usually runs in UTC). Changing it reschedules the daily jobs right away; a job already done today is not run again.
- The system prompt now ends with the current time in your time zone, to the minute, for example "Current time: 2026-11-11 15:30 (Asia/Shanghai, Wednesday)."
- API: `Settings.timeZone` (an IANA name such as `Asia/Shanghai`, or `UTC`; `null` follows the server), and `GET /api/v1/settings/time-zones` (login required) returns `serverTimeZone` and the `supported` list. Fixed offsets such as `+08:00` and abbreviations such as `CST` are rejected with 400. All changes are additive.
- Channels framework (ADR 0022), the base for using the assistant from IM; the WeChat adapter itself arrives in a later update. Settings → Channels lists channels and lets you enable or disable them, create a one-time 6-digit pairing code (10 minutes; voided after 5 wrong tries), see the bound owner account (last 4 characters only), unbind it, see the last error and the ignored / rate-limited counts, and switch an IM notice for degraded memory recall (off by default; once per 3 degradations in 10 minutes).
- WeChat channel over Tencent's iLink bot API (ADR 0024), built only from Tencent's public protocol document. Scan a QR code to log in (`POST`/`GET /api/v1/channels/{id}/wechat/login`, additive); the server then long-polls for messages, replies in plain text, and reconnects with exponential backoff (up to 5 minutes). When the login expires the channel shows "needs login" until you scan again. The login token is written to `secrets.yaml` in the data directory as `ILINK_TOKEN_<channel id>`: the server first copies the file to `backups/secrets-<UTC time>.yaml` (the newest 5 are kept), changes only that one line, and refuses to write if the file doesn't parse. Deleting the channel removes that line the same way. Not supported yet: images, files and voice audio (voice transcripts are used), and logins that ask for a PIN.
- In IM, only the bound owner's direct messages reach the assistant; everyone else's messages and group messages are ignored without a reply. Commands: `/new`, `/clear` (or 清空), `/source`, `/help`. `/clear` deletes only that channel's current conversation: it stops a running reply, deletes that conversation's attachment files, and does not delete memories or any other conversation. It does not ask for an approval code. Actions that need approval are sent as "需要确认:… 回复「确认 K7」或「拒绝 K7」"; only the owner's direct reply that is exactly that command counts, the code expires with the approval, and the audit log entry is the same as on the Web, with "(via channel …)" added. Forwarded chats, quoted messages and link cards are treated as untrusted content, like e-mail. Replies are converted to plain text and split into numbered parts. Duplicate deliveries are dropped (kept for 3 days), owner messages are limited to 20 a minute, and a busy conversation queues up to 5 messages.
- The session list has a delete control on each conversation, and "Clear all conversations" (with a confirmation that says memories are kept). `DELETE /api/v1/sessions` removes every conversation of the signed-in owner: active runs are stopped first, attachment files are removed the same way as deleting one conversation, and memories stay. Another owner's data is left alone. The change is additive. The client SDK adds `sessions.clear()`.
- API: `GET/POST /api/v1/channels`, `GET/PATCH/DELETE /api/v1/channels/{id}`, `POST /api/v1/channels/{id}/pairing`, `DELETE /api/v1/channels/{id}/binding`, `GET /api/v1/channels/{id}/status` (all need login); `capabilities` in `GET /api/v1/meta` now includes `channels`. Database migration 0014 adds the channel tables (the server backs up the database first, as for every migration). All changes are additive.

#### Fixed

- Knowledge map counts now match what you see when you expand a branch. The number is how many content items are inside (memories, mail, sessions, files, and so on). Category folders and hidden history versions are not included (ADR 0025). A message that is in both Inbox and Sent is listed under both, including Sent. Task memories (`episodic/task` and `semantic/task`) stay under Experiences or Facts; opening a branch reloads it, so a memory written after the page was opened shows up. Leaf titles are left-aligned.
- On Windows, `secrets.yaml` and the backup written with it no longer keep the profile's inherited access list. After each write the server runs `icacls` with no shell, removes inherited entries, and grants full control only to the current user. If that fails, the file is kept and a warning is logged.
- The one-second pause between WeChat long polls, and between QR-status polls that return immediately, ends as soon as the channel is stopped or the process shuts down.
- Hold to talk: a recording is no longer dropped as silent when the tab was in the background for part of it (the level meter doesn't run there), even if the first part was recorded in the foreground.
- Channels: four approval gaps are closed (ADR 0022). An approval notice in IM now lists the approval's warnings, one `Note: ...` line each (for example when an e-mail goes to a recipient that did not come from your own messages), and a long notice shortens the warnings, never the "reply Confirm K7 or Reject K7" line. After you approve or reject in the Web UI, replying with that code in IM says "Already handled." instead of "No such pending item." and runs nothing again; codes from other channels, expired codes and codes from before a restart still get "No such pending item." A message that quotes or forwards something is never an approval, even if its text is exactly "Confirm K7"; it goes to the assistant as a normal message with the quoted part marked as untrusted. Before a channel is bound, a wrong or expired pairing code, or one sent after the 5-try lock, gets no reply and counts toward the per-minute limit for ignored messages; a correct code still replies "Bound.".
- Channels: an address that only appears in a forwarded, quoted or link-card block no longer counts as a trusted recipient for `mail.send` (ADR 0016 section 7, ADR 0022 section 14). Only what you typed, and the sender / Reply-To of the mail you reply to, are trusted; the channel's untrusted blocks are stripped before the check (also when you typed a line that looks like one: at worst you see one extra warning). Existing conversations are covered too. When an approval notice in IM has to drop warnings to fit, it now adds "N more warning(s), see the Web UI" (in Chinese) and never cuts the reply sentence.

### M4 · Voice and images (2026-11-10)

Done. The owner's tests on Windows (2026-11-10) used DeepSeek (`deepseek-flash`) for chat and images and SiliconFlow for voice (`Qwen/Qwen3-ASR-1.7B`, `FunAudioLLM/CosyVoice2-0.5B`): transcription of MP3, WebM, Ogg and WAV, reading aloud and images all worked. With a real microphone the transcripts came out wrong (in another language) although the same formats transcribe correctly from synthetic audio; this points to the microphone input on that machine, and the owner decided to accept it. Firefox wasn't tested. See `docs/milestones/M4-self-check.md`. In CI, with a fake endpoint, FatCat-AI adds about 15 ms to a voice round trip (recording → reply → first audio), well under the 1-second target, and idle memory is unchanged at about 110 MiB.

#### Added

- Chat: you can attach up to 4 images to a message with the "Image" button, by pasting, or by dragging them onto the message box (PNG, JPEG, WebP or GIF, at most 5 MiB each; ADR 0020). Previews appear before sending and can be removed. Before uploading, the browser scales large images down to 2048 px on the long side, which also removes EXIF data such as GPS location. GIFs are uploaded as they are. Sent images are shown in the conversation and are visible only to you.
- Settings → Model profiles: a "Supports images" checkbox. Tick it only if you know the model can read images; FatCat-AI does not guess. If the current profile is not ticked, the chat explains why images can't be sent, and the server refuses them with `model_no_vision` instead of dropping them.
- Images work with all three providers (OpenAI-compatible, Anthropic and Gemini). Only the 8 most recent images in a conversation are sent to the model again; older ones, and images in automatically summarised history, are replaced by a short "[图片:name]" note.
- API: `POST /api/v1/attachments` (multipart upload) and `GET /api/v1/attachments/{id}`; `attachmentIds` when sending a message; an `image` message part; `vision` on model profiles; new error codes `model_no_vision`, `payload_too_large` and `unsupported_media_type`. The file type is checked from the file's first bytes, not from its name. All changes are additive.
- Voice API (ADR 0021): `POST /api/v1/voice/transcriptions` turns a recording (WebM, Ogg, MP4/M4A, WAV or MP3, at most 10 MiB) into text, and `POST /api/v1/voice/speech` reads up to 4,000 characters aloud as streamed MP3, Opus or WAV. Both use a model profile with the `stt` or `tts` purpose, which must be OpenAI-compatible; the key stays on the server. Each user can make 20 of each per minute. Recordings, transcripts and spoken text are not saved or logged; the log only records the profile, sizes and timing.
- Settings: a `voice` group (`defaultSttProfileId`, `defaultTtsProfileId`, `autoSend`, `autoSpeak`) and a `params.voice` field on model profiles for the TTS voice name (defaults to `alloy`). The client SDK has `voice.transcribe()` and `voice.speak()`.
- Chat: a "Hold to talk" button. Hold it (or hold Space outside the message box) and release to transcribe; a quick tap starts a voice message and a second tap ends it. Recordings stop at 120 seconds. By default the text is sent right away; turn off "Send automatically" in Settings → Voice to only fill the message box. Replies have a "Read aloud" button, and "Read replies aloud when they finish" reads every reply. Code blocks are skipped ("(code omitted)") and links are read as their text.
- Chat: a voice status indicator: a small particle sphere with a status line (idle, listening, thinking, speaking, or the tool in use, for example "Reading a web page…"). It pulses with the volume while you talk or it reads aloud, shows the same state on every open tab and device, uses a still circle when the system asks for reduced motion, and falls back to the text alone when the browser can't draw it.
- Settings → Voice: choose the speech-to-text and read-aloud profiles and the two switches above. Model profiles can now be given the `stt` and `tts` purposes in the form, plus a voice name for read-aloud.
- API: a `voice-state` WebSocket frame (the browser reports listening / speaking / idle; the server turns it into an `assistant-state` event for all your clients), a `label` on `assistant-state` events in your interface language, and `activityLabel` on tools.

- Model profiles: an optional `params.voiceProtocol` (`openai`, `openai-chat` or `volcengine`; default `openai`) to choose how a voice profile calls its service. Only `openai` is implemented so far; the other values are reserved and are refused with `validation_failed` until they are implemented.

#### Changed

- Hold to talk: recordings shorter than half a second, or almost silent, are not sent for transcription; the chat says "Didn't catch that" instead. Speech models tend to answer near-silence with made-up text in another language.

#### Fixed

- Editing a model profile no longer clears its "Supports images" setting when the change doesn't include it.
- Read aloud now also splits sentences at full-width ！？； and at an English full stop followed by a space (not inside numbers or domain names), and no longer drops the underscores in names such as `snake_case` or `__init__`.
- Stopping read-aloud no longer leaves an unhandled error in the browser console from the segment that was being prefetched.
- Closing one tab while another tab is still listening or reading aloud no longer resets the voice indicator to idle on your other clients.
- Code highlighting is retried for the next code block if loading it failed once (for example while offline).
- Image file names: zero-width and other invisible formatting characters are removed, as control and bidirectional characters already were.

#### Changed

- The data directory has a new `attachments/` folder. Files there are deleted with their conversation; images uploaded but never sent are removed after 24 hours. Include this folder if you back up the data directory yourself. A database migration (0013) runs on the first start.

### M3.x · Cleanup

#### Added

- Settings → Mail accounts: each account now has a "Copy in Sent" switch (`sentCopy`: auto, append or off; ADR 0016 §14) and explains what happens to the copy in Sent for the chosen option. On 163 and Gmail, choosing "always" warns that every message will appear twice, because those servers already save sent mail. Errors are shown on the account's own card. Before, this could only be changed through the API.
- Settings → General: a switch for automatic memory extraction (`memory.autoExtract`, off by default). While it is on, the Memory page shows a notice with a one-click button to turn it off; memories already saved are kept.
- Memory page: a "Where it came from" button on each memory lists its sources. For an automatically extracted memory it shows the model, whether the run succeeded (or its error code), the time and the prompt version (ADR 0007 §5.9); other sources say no run was recorded. While saving, the auto-extract checkbox is disabled.
- Chat: code blocks with a language (for example ` ```ts `) are now syntax highlighted, in light and dark themes. 14 common languages are supported; blocks without a language stay plain text. The highlighter loads only when the first such block appears.

#### Fixed

- Memory now drops back after a large mail sync. Syncing 10,000 messages used to leave the server at about 265 MiB, and it stayed there; it now settles at about 141–145 MiB and stays flat over repeated syncs. The server now limits the V8 young generation with `--max-semi-space-size=8`, which otherwise grew to about 128 MiB and was never returned, and the SQLite page cache is 4 MiB instead of 16 MiB. The flag is set automatically in the Docker image (`NODE_OPTIONS`) and by `pnpm dev` and `pnpm --filter @fatcat-ai/server start`, on Windows too; only if you start `node apps/server/dist/index.js` yourself do you need to add it.
- New `pnpm perf:mail-sync` runs this measurement against a local fake IMAP server with synthetic mail (Linux and Windows; after `pnpm build` it starts its own server, or with `ATTACH=<url>` measures one that is already running, such as `pnpm dev`). The numbers above come from this synthetic setup on a Linux host, not from the Docker container.

### M3 · Mail (2026-11-05)

#### Added

- **Mail accounts** (ADR 0016, [#35](https://github.com/CodingLossy/AI-Personal/pull/35), [#36](https://github.com/CodingLossy/AI-Personal/pull/36)):
  - add IMAP/SMTP accounts in Settings → Mail accounts, with presets for QQ, 163 and Gmail;
  - passwords (app passwords or authorization codes) are only referenced as `env:NAME` or `file:NAME`, never stored in plaintext; only TLS and STARTTLS are supported, and OAuth is not;
  - "Test connection" checks the IMAP and SMTP logins without sending anything.
- **Sync** ([#36](https://github.com/CodingLossy/AI-Personal/pull/36)):
  - Inbox and Sent are synced every 5 minutes by default, the first time only for the last 30 days (`initialSyncDays`);
  - read state and deletions follow the server, and bodies are always read with `BODY.PEEK`, so FatCat-AI never marks mail as read;
  - the IMAP `ID` command is sent after login, which 163 requires;
  - headers, a plain-text body and the attachment index are cached locally; attachments are only downloaded when you ask;
  - sync runs in a short-lived child process, so idle memory stays the same when no account is configured.
- **Mail tools** ([#37](https://github.com/CodingLossy/AI-Personal/pull/37)): `mail.list` (including "unread today"), `mail.search`, `mail.read` and `mail.summarize` (read, output marked as untrusted), `mail.draft` (saves a local draft) and `mail.send` (sends a saved draft only, needs your approval every time and can't be pre-authorized). If a draft changes while its approval is pending, the approval is cancelled. After sending, a copy goes to the server's Sent folder, either saved by the server itself or appended by FatCat-AI (see Fixed below).
- **Session-level taint** ([#37](https://github.com/CodingLossy/AI-Personal/pull/37)): once any tool in a session returns untrusted content (web, files or mail), the whole session stays tainted, also after a restart. In a tainted session conditional pre-authorizations no longer apply (so `memory.write` always asks), and a recipient that neither you typed in the session nor is the sender of the mail being answered gets a red `recipient_untrusted` warning on the approval card.
- `pnpm eval` also runs 14 mail injection cases.
- **Mail in the knowledge map and the Web UI** ([#38](https://github.com/CodingLossy/AI-Personal/pull/38)):
  - the knowledge map shows Mail → account → folder → thread → message; bodies are not added to the item search;
  - a new Mail page lists messages by account and folder, shows plain-text bodies, can sync now, and lets you view, edit and delete drafts;
  - "Add to knowledge base" on an attachment (`.md`, `.txt`, `.pdf`, `.docx`, `.xlsx`, up to 20 MB) indexes it for `kb.search` with the same credential guard as files; only the chunks are kept;
  - "Ask AI" on a message opens a new session that is tainted from the start, with a suggested prompt that names only the message id.
- New endpoints under `/mail`: presets, accounts (with folders, test and sync), messages, ask, attachments to the knowledge base, and drafts.

#### Fixed

- Sending from a 163 account no longer leaves two copies in Sent. 163 (like Gmail) saves mail sent over SMTP by itself, and FatCat-AI also appended its own copy. Accounts now have a Sent copy setting, `sentCopy` (ADR 0016 §14):
  - `auto` (the default): no copy is appended for `imap.163.com` and `imap.gmail.com`, because the server keeps one; every other host, including your own, gets a copy appended;
  - `append` or `off`: always or never append a copy, on any host. Setting `appendToSent` to `true` or `false` sets these too, and what you set explicitly is never overridden by the host.
  - The account response shows `sentCopy` and, in `appendToSent`, whether FatCat-AI will append a copy for that account.
  - In the result of `mail.send`, `savedToSent` only means that FatCat-AI's own append succeeded. A copy the server saves by itself is not checked. The new `sentCopy` field says what happened: `append`, `append-failed`, `server`, `off` or `no-sent-folder`.
  - A duplicate that was already saved stays on the server.
- A message that is in both Inbox and Sent (for example one you sent to yourself) now shows up in both the Inbox and the Sent filters, and in "unread today".

#### Upgrading

- Existing accounts can't tell a default from a choice, so `appendToSent: true` becomes `sentCopy: auto` and `false` becomes `off`. Only 163 and Gmail accounts that had `true` stop appending; to keep appending there, set `sentCopy` to `append`.

#### Notes

- "Today" means today in the server's time zone (the container's `TZ`), not necessarily yours.
- Pre-authorizations you saved with "always" (such as `fs.write` for a folder) still apply in a tainted session. Set them with care.
- Contacts and "people" items are moved to M5. Gmail/Outlook OAuth, IDLE, rich HTML rendering, scheduled digests, write actions such as marking as read, other folders and automatic attachment import are deferred.
- The Docker image idles at 110 MiB in CI with no mail account (limit 120 MiB). The self-check is in [docs/milestones/M3-self-check.md](docs/milestones/M3-self-check.md).

### M2 · Tools and files (2026-11-05)

#### Added

- **Tool framework and approvals** (ADR 0010):
  - every tool has a risk level (`read`, `write`, `external`, `dangerous`) that decides whether it runs directly or needs your approval;
  - approval requests are saved and expire after 30 minutes;
  - when approving, you can choose "always in this session" or "always", except for tools that send things out or are dangerous;
  - pre-authorizations are listed in Settings and can be revoked;
  - a pending approval from any session shows in a panel at the top of the Web UI;
  - a local audit log (Web UI → Audit) records writes, outgoing actions, denied calls and pre-authorization changes, with redacted inputs.
- New endpoints `GET /tools`, `GET /approvals`, `GET` / `DELETE /preauthorizations` and `GET /audit`. `POST /approvals/{callId}` accepts an optional `remember`.
- **Built-in tools**:
  - `time` (current time in any IANA time zone);
  - `calc` (exact arithmetic with its own parser, no `eval`);
  - `web.fetch`:
    - fetches a page as text, marked as untrusted content;
    - needs approval and can only be pre-authorized per domain;
    - blocks loopback, private, link-local and cloud metadata addresses, including after DNS lookups and redirects;
    - limits responses to 2 MB and 15 seconds.
- **File tools** (ADR 0011):
  - `fs.list`, `fs.read` and `fs.search` (read) and `fs.write` and `fs.move` (write, need approval) only work inside the folders you authorize in Settings → Authorized folders.
  - Paths are resolved to their real location (links, junctions and Windows 8.3 short names) before checking.
  - Alternate data streams, device names, UNC paths and names ending in a dot or space are rejected.
  - Writes are atomic and never replace a file unless asked.
  - Write approvals can only be remembered per folder.
  - Out-of-folder attempts are audited.
- **Knowledge map, data layer** (ADR 0012): files in your authorized folders, detected novels (book → chapter, UTF-8 or GB18030) and sessions are indexed as items with consistent counts. `/api/v1/items/*` lists roots, children, ancestors, counts, subtrees, search and changes, and opens items after re-checking file permissions. Read-only `items.*` tools let the model browse it. The Web UI has a minimal tree browser. Revoking a folder soft-deletes its items.
- **Document reading**: `fs.read` turns PDF, DOCX and XLSX files into text, with PDF pages and XLSX sheets labelled. Parsing runs in a short-lived worker thread with memory and time limits, so idle memory is unchanged. Encrypted documents and ZIP bombs are refused.
- **MCP client, stdio only** (ADR 0013): add local MCP servers in Settings → MCP servers or with `/api/v1/mcp/servers`. Their tools appear as `mcp.<server>.<tool>` and, whatever the server claims, need your approval by default; you can set a per-tool level through the API. The command runs without a shell and only receives a minimal environment plus variable names you list (never `AIP_*`); no values are stored. Output, including error text, is marked as untrusted. Removing a server also removes its pre-authorizations. The client code loads only when a server is configured, so idle memory is unchanged. Streamable HTTP is deferred.
- **Embeddings and vector index** (ADR 0014): OpenAI-compatible profiles with the `embed` purpose can now embed text through `/embeddings`. Vectors are stored with sqlite-vec in a table sized to the profile's dimensions, and are removed together with their items. A background queue embeds one batch at a time, retries with backoff and stops at a daily limit (5,000 texts by default). If you change the embedding model or its dimensions, Settings → Vector index asks you to rebuild. `GET /embeddings/status` and `POST /embeddings/rebuild` are new. sqlite-vec is only loaded when an embed profile exists or a vector index was built before. The knowledge base and memory search will use this in later PRs.
- **Local knowledge base** (ADR 0015): Markdown, text, PDF, DOCX and XLSX files in your authorized folders are split into chunks by heading and paragraph, keeping PDF page numbers. You can set the chunk size in Settings (default 1,000 characters). Chunks are embedded when an embed profile exists. The new `kb.search` tool (read) uses vector search and falls back to full-text search. It returns numbered passages with the file name and page, and the Web UI shows them as citations. Indexing is incremental, and deleting a file or revoking a folder removes its chunks and vectors.
- **Memory v2 groundwork** (ADR 0007 §5): the database is migrated to the memory v2 schema without rebuilding M1 tables, and the database is backed up first. Existing memories keep their text. They now appear in the knowledge map as Memory → domain → type, with replaced values under a hidden "History" folder and linked to the value that replaced them. New contract types for memory v2 and the `memory-used` event are added; the behaviour of `memory.save` / `memory.search` does not change yet.
- **Memory write path** (ADR 0007 §5.5):
  - credentials (API keys, tokens, JWTs, private keys, passwords, connection strings, TOTP seeds, high-entropy strings) are refused before anything is stored;
  - bank card numbers, ID numbers, mobile numbers and detailed addresses are replaced with placeholders before a memory is saved;
  - entity keys are normalized; repeated facts are merged; a new value for a single-value key replaces the old one, or both are marked as conflicting when the new value is less certain;
  - invalid, overlong or instruction-like content from outside sources goes to a quarantine for 14 days instead of memory.
- New tool `memory.write` (`memory.save` is now its alias). It saves without asking when your own message triggered it, nothing sensitive is involved and no profile fact is replaced; otherwise it asks for approval. Settings: `memory.alwaysApprove` asks every time.
- Automatic memory extraction after each turn (off by default; `memory.autoExtract`, at most `memory.extractDailyLimit` = 200 cheap-model calls per day). It only reads your message and the final answer, never tool output; after a turn that read outside content it only proposes memories into the quarantine.
- **Memory retrieval** (ADR 0007 §5.6): relevant memories are now added to the conversation automatically.
  - Recall combines full-text search (with a Chinese two-character fallback), vector search when an embed profile exists, and linked items.
  - Each memory is shown with a trust label: reliable, possibly stale, conflicted or inferred. The top results include where they came from.
  - The memory block is limited to `memory.blockTokens` (default 1,200 tokens, and at most 10% of the model's context).
  - A short digest of pinned memories, profile facts, accepted decisions and open conflicts is added at the start of each session (`memory.digestTokens`, default 400).
- New tool `memory.retrieve` (`memory.search` is now its alias) and endpoints `POST /memory/retrieve` and `GET /memory/digest`. The `memory-used` event is now sent with the memories used in each turn.
- **Memory maintenance** (ADR 0007 §5.7): every day at 03:30 (server time) memories decay by type (half-life 30 days for experiences, 180 for methods, 365 for facts, 90 for finished decisions; pinned and profile facts do not decay). Rarely used memories move to cold and then archive storage, archived memories lose their vectors but stay searchable by text, and facts past their end date expire. Using a memory again brings it back. The jobs run in small batches and wait while a chat is running.
- **Memory feedback and management** (ADR 0007 §5.8):
  - after a reply, "Memories used this turn" lists the memories the assistant saw, with Helpful, Out of date, Wrong (with an optional correction that replaces the memory at once) and Should not be kept (deletes it);
  - the Memory page shows each memory's history, conflicts to confirm (keep one, keep both or dismiss) and the quarantine, where you can confirm a candidate;
  - memories appear in the knowledge map as Memory → domain → type; older versions are hidden by default.
- New endpoints `POST /memory/{id}/feedback`, `GET /memory/{id}/sources`, `GET /memory/{id}/history`, `GET /memory/conflicts`, `POST /memory/conflicts/{id}/resolve`, `GET /memory/quarantine` and `POST /memory/quarantine/{id}/promote`; `GET /items/{id}/children` gains `includeHidden`. New tools `memory.digest`, `memory.feedback` and `memory.forget` (always needs approval).
- Undoing a new memory and forgetting a memory are now recorded in the audit log (memory id only).
- **Choose which folders go into the knowledge base** (ADR 0015 §6): each authorized folder has a "Use in knowledge base" switch in Settings (`PATCH /fs/roots/{id}`, `knowledgeBase`). It is off by default; turning it off removes that folder's chunks and vectors.
- **Credentials are kept out of the knowledge base** (ADR 0015 §7): before a chunk is stored, API keys, tokens, passwords and similar secrets are replaced with "[已隐藏凭据]", and a chunk that still looks like a credential is dropped.
- `pnpm eval` runs the memory evaluation set (32 Chinese cases for recall, superseding, conflicts, injection, credentials and stale labels) in replay mode and prints the recall, stale and error rates.

#### Changed

- **Upgrading**: after the migration no authorized folder is in the knowledge base, so existing chunks are removed at the next indexing until you switch the folders back on.
- Chinese two-character recall no longer drops content words such as 「过敏」 or 「吉他」.

- `memory.search` with a query no longer falls back to the 20 most recent memories when nothing matches; an empty query still lists them.
- Approvals that were pending when the server restarted now expire instead of being lost silently.

### M1 · Chat core (2026-11-04)

#### Added

- **Bring your own model**: model profiles for any OpenAI-compatible endpoint (OpenAI, DeepSeek, OpenRouter, Ollama, LM Studio, vLLM…) and the native Anthropic Messages and Gemini APIs, all streamed. Profiles have purposes (`chat`, `cheap` for summaries), a connection test, and default chat / cheap profiles in settings. ([#4](https://github.com/CodingLossy/AI-Personal/pull/4), [#10](https://github.com/CodingLossy/AI-Personal/pull/10))
- **Keys never in plaintext**: profiles only reference keys as `env:NAME` (environment variable) or `file:NAME` (`secrets.yaml` in the data directory); `keyStatus` shows whether the key is found. Keys are redacted from logs, errors and recorded fixtures. ([#4](https://github.com/CodingLossy/AI-Personal/pull/4))
- **Versioned API `/api/v1`**: owner setup (local only, or with a one-time setup code), password login with cookie session + CSRF, personal access tokens, a login rate limit, problem+json errors, and an OpenAPI 3.1 document at `/api/v1/openapi.json` (authentication required). Every endpoint except three public ones returns 401 without credentials. ([#1](https://github.com/CodingLossy/AI-Personal/pull/1), [#3](https://github.com/CodingLossy/AI-Personal/pull/3))
- **Sessions and runs**: streamed replies over server-sent events, decoupled from the connection; resume with `Last-Event-ID`; cancel, retry and regenerate (old replies are kept as branches); idempotent sends with `clientMessageId`; a WebSocket event channel that replays missed events with `lastSeq`. ([#6](https://github.com/CodingLossy/AI-Personal/pull/6))
- **Tools and approvals**: a tool loop with an approval step; tools that need approval pause the run until you approve or reject them. ([#7](https://github.com/CodingLossy/AI-Personal/pull/7))
- **Memory v1**: the assistant can `memory.save` (needs your approval) and `memory.search`; credentials are refused. List, search, edit, retract and delete memories over the API, the CLI and the Web UI. Long sessions are summarized with the cheap profile; the original messages are always kept. ([#7](https://github.com/CodingLossy/AI-Personal/pull/7))
- **Storage**: a single SQLite database in the data directory with versioned migrations, a backup before each migration, and foreign keys enforced. ([#2](https://github.com/CodingLossy/AI-Personal/pull/2))
- **Client SDK `@fatcat-ai/client`** (Apache-2.0, no runtime dependencies) and the **`fatcat-ai` CLI**: `setup`, `login`, `chat`, `ask`, `sessions`, `models`, `memory`, `approve`, `serve`. ([#8](https://github.com/CodingLossy/AI-Personal/pull/8))
- **Web UI**: setup and sign-in, session list, streamed Markdown chat that resumes after a page refresh, approve / reject buttons, settings (language zh-CN / en, light / dark / system theme, default profiles), model profile management and a memory page. ([#9](https://github.com/CodingLossy/AI-Personal/pull/9))
- `GET` / `PUT /api/v1/settings`. ([#9](https://github.com/CodingLossy/AI-Personal/pull/9))
- Real recorded DeepSeek fixtures for replay tests; keys are never written to fixtures, and CI scans them. ([#5](https://github.com/CodingLossy/AI-Personal/pull/5))

#### Notes

- Only one owner account (1.0 is single-user). The server listens on 127.0.0.1 by default; use a reverse proxy with HTTPS to expose it.
- The Docker image stays under 120 MiB of idle memory (95 MiB in CI).

### M0 · Project scaffolding (2026-11-03)

#### Added

- pnpm + Turborepo monorepo with TypeScript strict, ESLint, Prettier and Vitest; the `apps/` and `packages/` layout from the plan.
- Minimal Hono server (`/healthz`, `/api/v1/meta` with license and source URL) and a Vite + React Web UI shell.
- Dual licensing (AGPL-3.0-only + commercial), CLA, trademark and security policies, SPDX headers, REUSE compliance, and CI checks for licenses, placeholders and dependency licenses.
- Multi-stage Dockerfile (non-root) and docker-compose; CI builds the image and checks idle memory.

---

## 中文摘要(未发布)

### M7 · 插件(进行中)

- 插件开发指南(`docs/plugins/developing-plugins.md`,另有中文版;英文待校对)与 M7 自检报告(`docs/milestones/M7-self-check.md`)。
- 插件升级与回退(ADR 0040 第 6.2 节):检查一个版本高于已装版本的包(本地目录或「市场」页签)时,安装确认页变成升级确认页,列出权限变化:新工具、工具级别升高、工具开始外发数据、新域名、新密钥和新条目类别都需要你同意,减少的权限也会列出;确认之前旧版本照常运行。升级会先备份 `plugin-data/<id>/`(超过 500 MiB 不自动备份,必须明确选择「不备份」才能升级),再启动新版本并做健康检查(握手、`tools/list`、声明的工具都在);没通过就换回旧版本、数据和状态并记下原因。级别升高、开始外发数据或被删除的工具,旧的预授权会被撤销并审计。上一个版本的代码与数据备份各留一份,`POST /plugins/{id}/rollback`(「回退」按钮)用它们恢复。`engines.fatcat` 不再满足核心版本的插件,启动时标为 `incompatible` 且不启动,装上兼容的新版本即恢复。新增错误码 `plugin_upgrade_failed`、`plugin_backup_too_large`、`plugin_network_unsupported`;没有数据库迁移。
- 没有操作系统层网络隔离的平台(例如 Windows)上,拒绝安装声明了联网的本地目录插件;请从已审核的市场安装,或去掉 `net` 权限。
- 插件市场(ADR 0040 第 5.2、5.3 节):插件页有「市场」页签。打开时下载一次签名的插件索引(只发一个 GET,不带任何标识;之后只在点「刷新」时再下载)并列出里面的插件;点「查看权限并安装」会下载并检查包,先显示与本地安装相同的权限与保护程度确认页,确认后才安装。索引用 Ed25519 验签(内置主用和备用两把公钥,任何一把签的都接受),新索引的 `serial` 不能小于缓存的、也不能已过期,每个包都按已签名索引里的大小和 SHA-256 核对。包由内置的 tar 读取器解开,拒绝符号链接、`..`、盘符、Windows 保留名、仅大小写不同的重复路径和压缩炸弹;下载只走 `https:` 并且只能去索引列出的主机,地址检查与 `web.fetch` 相同(含 fake-IP 开关)。更新失败或被拒绝时继续用缓存里的旧索引并说明原因,缓存过期后不能安装。被市场下架的版本不再展示也不能安装,已装的会显示警告(不自动卸载)。设置里有关闭市场的开关(不下载索引,外连清单里也没有市场地址)。`scripts/plugins/` 里是索引仓库的 CI 检查与业主本机的签名脚本(见其 README)。API 新增:`GET /plugins/market`、`POST /plugins/market/refresh`、`POST /plugins/prepare` 的 `source: { kind: 'market', ... }`,以及错误码 `market_disabled`、`market_unavailable`、`plugin_download_failed`、`plugin_too_large`、`plugin_checksum_mismatch`、`plugin_manifest_mismatch`、`plugin_yanked`。校验和与签名只说明下载的是审核时的那个包,不说明审核者批准的包无害。
- 插件的密钥绑定可以解除:清空输入框并保存即解除绑定,解除必需的密钥时插件同时被停用。
- 修复:插件设置校验不再把对象原型上的名字(`constructor`、`toString`、`__proto__`)当成已声明的设置;域名解析不到地址时,对插件报告为请求失败,不再记为被拒绝。
- 插件能力(ADR 0040 第 3.3 节):`fatcat/net.fetch` 让插件经服务器发 HTTPS 请求,只能访问它被授权的域名,并受和 `web.fetch` 相同的地址检查约束(私网、回环、云元数据、fake-IP 地址;每一次重定向都重新检查;30 秒超时、响应体 2 MiB、不带 Cookie);被拒绝的调用记为插件的 `denied` 事件。插件可以给知识地图添加自己的类别:同步时服务器拉取 `roots` / `children`,打开条目时调用 `open`;插件也可以用 `fatcat/items.upsert` 推送条目(每个插件最多 50,000 条,单条 `meta` 不超过 8 KiB,只能放在它声明过的类别下);卸载插件会删除它的条目。插件设置现在会在启动时传给插件(`FATCAT_PLUGIN_SETTINGS`,SDK 里的 `ctx.settings`),修改后插件会重启。插件的任务模板可以在插件页建成任务草稿;草稿要在任务页确认后才会运行,卸载插件时会停用由它的模板建出的任务。`examples/plugins/hello` 展示了以上全部能力。
- Web 插件页(ADR 0040 第 9 节)与 CLI `fatcat-ai plugins list|install|stop|remove`。从本地目录安装时先复制并检查包(不运行),再显示它要的权限和当前平台的保护程度表;全部同意后才安装。已安装的插件可以启用、停用、停止,有按清单 `settings` 渲染的设置表单(服务器现在会校验)、`env:` 密钥绑定、可选的内存设置与最近的内存读数,卸载对话框会列出将被停用的任务,并提醒插件数据不在自动备份里。任务页会显示因插件被卸载而停用的原因。API 增量:插件的 `settingsSchema`、插件详情的 `protections`、任务的 `disabledReason`。
- 插件网络隔离的探测改为异步(第一次使用时不再阻塞事件循环),macOS 上改为让沙箱里的子进程真的去连一次本机端口来验证。还没有在真机 macOS 上验证。
- 插件清单契约(ADR 0040):`plugin.json`、市场索引、`engines.fatcat` 版本范围和 `fatcat/*` 扩展消息的 schema 放进 `@fatcat-ai/shared`,服务器、SDK 与索引仓库共用同一个校验。未知字段、`dangerous` 工具、`broad` 域名、`FATCAT_AI_*` 密钥名和非免费授权都会被拒绝。目前还不能安装插件,运行时和界面在后续 M7 改动中提供。
- `@fatcat-ai/plugin-sdk`(Apache-2.0,暂未发布到 npm):`definePlugin`、`registerTool`、`registerItemProvider`、`ctx.fetch`、`ctx.log`,自带最小的 stdio MCP 服务端和 30 秒心跳。示例插件 `examples/plugins/hello` 也是一个普通的 MCP 服务器。
- 插件数据库迁移 0018(ADR 0040 第 7 节):新增 `plugins`、`plugin_events` 两张表和可为空的 `tasks.disabled_reason` 列,以及对应的 storage 仓储。不改已有表和数据,目前没有代码读取新表;迁移前照常自动备份。旧版本不能直接打开已迁移的库(会报 unknown to this version 并拒绝启动);回滚办法:停掉服务,用 `backups/db-…-pre-0018.sqlite` 恢复,再运行旧版本;备份之后写入的数据会丢失。

### 内存

- 内存改为只测量、只报告,不再设门禁(ADR 0041,取代 ADR 0018)。CI 不再因空闲内存、负载后回落或渠道增量而失败,数字仍写进 job summary。README 与 Docker 指南不再承诺 2 GB 服务器,2 GB 仅是建议。`.github/memory-baseline.json` 保留为记录值。

### 改名为 FatCat-AI

项目由 AI-Personal 改名为 FatCat-AI,仓库迁到 <https://github.com/CodingLossy/FatCat-AI>(ADR 0019)。

- 包名改为 `@fatcat-ai/*`,命令改为 `fatcat-ai`,Docker 镜像改为 `fatcat-ai`;客户端 SDK 导出 `FatCatClient`、`FatCatApiError`、`FatCatNetworkError`。
- 默认数据目录改为 `~/.fatcat-ai`。首次启动时服务器把已有的 `~/.ai-personal` 迁过去(重命名,跨盘时复制并校验);已有 `~/.fatcat-ai` 时不覆盖。Docker 仍用 `/data` 与 `ai-personal-data` 卷。
- docker compose 服务名由 `ai-personal` 改为 `fatcat-ai`。已经用 compose 部署过的,升级前先用旧版的 compose 文件执行 `docker compose -f docker/docker-compose.yml down`,或者升级后用 `docker compose -f docker/docker-compose.yml up -d --build --remove-orphans` 启动,否则旧容器会一直占着 8787 端口;数据仍在原来的卷里。
- Windows 上旧服务器仍在运行时,数据目录无法迁移(`EPERM` / `EBUSY`)。服务器会重试几秒,仍失败就提示先停止旧的 AI-Personal 服务器并退出,不移动也不删除任何文件。
- 环境变量前缀由 `AIP_` 改为 `FATCAT_AI_`(如 `FATCAT_AI_PORT`、`FATCAT_AI_DATA_DIR`、`FATCAT_AI_TOKEN`);旧名暂时仍可用,并打印弃用警告。
- 有意不改:令牌前缀 `aip_pat_`、Cookie `aip_session` / `aip_csrf` 与响应头 `X-AIP-Server-Version`,现有令牌与 API v1 客户端不受影响。

### M6 · 定时任务与自动化(进行中)

- 通用任务调度器(ADR 0033,迁移 0016):任务与运行记录存在数据库里,按用户时区排期,重启后仍然有效;每次运行只记录状态、错误码和时间(不存内容)。失败按 1、5、15 分钟重试;服务器关闭期间错过的触发按任务设置跳过或只补跑一次;任务可设静默时段;同时最多运行两个任务。记忆维护(衰减、分层、过期)现在是内置系统任务「记忆维护」,可以停用、立即运行或改时间。新增 Web 页面「任务」与 `/api/v1/tasks` 接口(客户端 SDK 同步)。自建任务、事件触发和自然语言创建在 M6 之后的改动中加入。
- 预授权域名(ADR 0039):任务预授权表单说明匹配规则(`example.com` 只匹配它本身,`*.example.com` 匹配所有子域但不含 `example.com`),填裸域名时提示补上 `www.` 或 `*.`,可用逗号填多个;带协议、路径、端口或过宽的通配(`*.com`)时保存前给出中文报错。库里以前存下的、缺了域名的预授权不再生效。
- 自建任务(ADR 0034):任务按时把一段提示词交给助手,在独立的会话里无人值守地运行;需要审批的操作照旧等你确认,30 分钟没人答复就拒绝。任务可以把结果推送到你自己的微信渠道:每次推送都需要你审批、不能预授权,目标渠道由任务配置决定,模型改不了。每个任务可以有一个可选的预授权白名单,让读 / 写类工具直接执行(默认为空;会对外发送或在本机之外执行的工具永远不能进白名单)。
- 任务的事件触发(ADR 0035,迁移 0017):新邮件到达(只告诉任务来了几封)、授权目录里的文件变化(5 秒去抖)、或带任务专属令牌的 Webhook 调用都可以触发任务(令牌只存哈希;令牌缺失或错误一律返回同样的 401)。事件触发的任务每小时最多运行 12 次,任务正在运行时来的事件会被忽略,事件携带的内容只会作为不可信数据交给助手。
- 用一句话创建任务(ADR 0036):在任务页输入「每天早上 8 点总结未读邮件」,模型只生成草稿并显示成卡片。草稿在你于已登录的网页里点「确认并启用」之前不会运行(访问令牌不能确认);一句话不能带白名单,也不能选推送目标,推送只会发到你自己已绑定的渠道,仍需逐次审批。
- 记忆整理(ADR 0037,默认关闭):可选的每日系统任务(04:00),把同一话题下 3 条以上零散记忆合成一条更高层的记忆,原条目保留;凭据仍然拒存,指令性文字进隔离区。每次最多 10 次模型调用、新增 20 条,每天一次。在任务页打开。

#### 修复

- 文件变化触发器:在 Windows 上删除被监听的目录会让 `fs.watch` 不停触发、CPU 空转。现在监听器发现目录已不存在就停止并只记一条错误。授权目录被撤销后,任务页会给出警告;重新授权同一个文件夹会生成新的编号,需要在任务里重新选择目录。
- 错过的触发只记一次:错过策略为「跳过」(以及超过 24 小时的补跑,含内置的记忆整理任务)时,重启不再重复记同一条「错过」。
- 被限流的事件触发记为 `event`(原来写成 `schedule`);记忆整理今天的名额用完时,手动运行会记为跳过并提示「今天的名额已用完」。

### M5c · 发布收尾(进行中)

#### 新增

- Docker 一键部署指南(`docs/deploy/docker.md`,英文版待校对):`docker/docker-compose.prod.yml` 同时跑应用与 Caddy(自动 HTTPS),只有 Caddy 发布端口,应用容器内存上限 512 MiB,主密钥用 Docker secret 文件传入;另有 `Caddyfile.example`、用于 DNS-01 的 DNSPod(腾讯云 DNS)变体(固定版本的社区插件,仅作示例,不是项目依赖)。指南包含公网暴露前的加固、备份恢复、升级和排错。ADR 0031 记录反向代理的责任划分与一条已知限制:经代理访问时登录失败限速把所有访客算作同一个来源。CI 新增不依赖域名的部署冒烟(HTTP 版 Caddy,检查 `/healthz`、设置码、WebSocket 与 SSE 逐块到达,不访问公网)。

#### 变更

- 手机抽屉:点指向当前页的链接也会关闭;打开时焦点移入抽屉,按 Esc 或点遮罩关闭时焦点回到「菜单」按钮;邮件里「返回列表」后焦点回到刚才打开的那封邮件。
- **新增**:发布准备(ADR 0032)。`.github/workflows/release.yml` 在改动 Dockerfile 的 PR 和手动触发时,分别在原生 runner 上构建 `linux/amd64` 与 `linux/arm64` 镜像并做健康检查,**默认不推送**:只有 `v*` tag,或手动触发并勾选 `push` 才会推送到 GHCR(手动只得到 `sha-<7>` 标签)。标签策略与「确认没有发布」的核对见 `docs/release/image-tags.md` 与 `scripts/check-no-release.mjs`。`docs/release/` 里有 v1.0 发布说明草稿(英文待校对;推荐的模型组合留空等业主确认)。README 快速开始改为以 Docker 开头。新增 `scripts/perf/chat-peak.mjs`,在镜像里测对话时的内存峰值。没有打 tag、没有发 Release、没有推送镜像。
- Web UI 适配手机尺寸(360 px 起,竖屏与横屏)。宽度小于 720 px 时侧栏变成顶栏打开的抽屉(点遮罩、按 Esc 或换页即关闭);控件高度不低于 44 px,输入框用 16 px 字号避免 iOS 聚焦时放大;邮件页改为「列表 → 邮件」两屏并带「返回列表」按钮;审计表在自己的容器里横向滚动;输入区贴底并避开安全区。页面加了 `viewport-fit=cover` 与 `theme-color`。不改任何接口。真机(iOS Safari、Android Chrome 软键盘)尚未验证。

### M5b · 密钥、TOTP 与知识地图(进行中)

- **新增**:密钥加密存储(ADR 0026)。`secrets.yaml` 可以整体加密为 `secrets.yaml.enc`(AES-256-GCM,信封 `fcsec1`),不会自动进行:在「设置 → 密钥」查看状态、主密钥来源与指纹,确认后迁移(并选择已有明文备份保留、加密或删除),或用离线命令 `node dist/index.js secrets migrate`、`secrets rekey --new-key-file <文件>`、`secrets cleanup`。迁移顺序为备份、写入并回读校验加密文件,全部通过后才把明文改名为 `secrets.yaml.migrated`,任何一步失败都保留明文原样。主密钥来自 `FATCAT_MASTER_KEY`、`FATCAT_MASTER_KEY_FILE` 或自动生成的 `master.key`(权限 600)。全新安装从第一个密钥起就写加密文件。主密钥缺失或不匹配时服务器照常启动,依赖密钥的功能报「密钥不可用」,不改动任何文件。`master.key`、`secrets.yaml.enc`、`secrets.yaml.migrated` 不会进仓库(`pnpm check:secrets`)。
- **接口**:新增 `GET /api/v1/settings/secrets` 与 `POST /api/v1/settings/secrets/migrate`(请求体 `confirm: true`,可选 `plaintextBackups`:`keep` / `encrypt` / `delete`),响应里没有任何密钥值;均为增量。
- **新增**:外连目标清单(ADR 0028)。「设置 → 外连目标」按类别只读列出当前配置下本服务器可能连接的全部地址:对话 / 嵌入 / 语音模型配置档、邮件账户(IMAP 与 SMTP)、微信渠道(停用的标为未启用)和 MCP 服务器(stdio 类显示为本地进程,其自身的网络访问不在清单内)。只显示 `协议://主机[:端口]`,不含路径、查询、凭据与密钥引用名。由你在对话里逐次审批的网络工具(如 `web.fetch`)去哪里由对话决定,不列在清单里。清单由配置现算,无迁移、无新依赖。新增 CI 检查 `pnpm check:egress`:生产代码里有文件使用网络 API 却没有登记在 `scripts/egress-registry.json` 时失败。
- **接口**:新增 `GET /api/v1/settings/egress-targets`(需要登录,只读);为增量。
- **新增**:TOTP 两步验证(ADR 0027)。在「设置 → 安全」里开启:输入密码,用验证器 App 扫描二维码(RFC 6238:SHA-1、6 位、30 秒,允许前后各偏一个步长),输入验证码确认,并保存 10 个一次性恢复码(只显示这一次)。开启时其他已登录的会话全部退出,当前浏览器保持登录。开启后登录需要密码加验证码(或恢复码);同一个时间步长的验证码只能用一次;连续输错 5 次登录尝试作废,失败次数按用户名和 IP 分别限速。共享密钥用 ADR 0026 的主密钥加密后入库(主密钥不可用时,带验证码的登录会失败而不是被跳过),恢复码只存加盐哈希。已有的个人访问令牌不受影响;开启后创建新令牌需要通过第二因素的浏览器会话,令牌本身不能管理 TOTP。验证码和恢复码都丢了:在服务器本机运行 `node dist/index.js auth reset-totp`,会删除 TOTP 数据、让所有会话退出并写一条审计。`secrets rekey` 现在会在同一个数据库事务里一并重新加密库中的共享密钥。命令行客户端登录时会询问验证码。数据库迁移 0015 新增两张表和一列,不改已有数据(照常先备份)。
- **接口**(只增):已启用 TOTP 的账户 `POST /api/v1/auth/login` 返回 `202` 与 `LoginChallenge`(不设会话 Cookie);未启用的账户响应与以前完全相同。新增 `POST /api/v1/auth/login/totp`、`GET /api/v1/auth/totp`、`POST /api/v1/auth/totp/setup`、`enable`、`disable`、`recovery-codes`;响应带 `Cache-Control: no-store`。
- **新增**:知识地图中的「人物」(ADR 0029)。新增顶层类别「人物」,列出已同步邮件里的联系人:你发过邮件的收件人(To / Cc),以及给你来信不少于 2 封的发件人;自己的地址与明显的系统发件地址(`noreply`、`no-reply`、`donotreply`、`do-not-reply`、`mailer-daemon`、`postmaster`、`notification(s)`)不计入。每个人物显示名称(最近一次的非空显示名,去掉控制字符)、地址、邮件数与最近往来时间,并关联其最近 200 封邮件。只读取 From、To、Cc,不读正文。带 `List-Id` 头的群发邮件暂未排除:本地邮件缓存没有保存该头,需要数据库迁移,留待后续。
- **接口**:新增 `GET /api/v1/items/{id}/related`,返回条目的非 primary 关联(出边与入边,如人物的邮件、邮件涉及的人物),游标分页,可按 `rel` 过滤;需要登录,只读;为增量。客户端 SDK 增加 `items.related`。关联不改变条目计数。无需迁移。
- **新增**:知识地图的分类浏览器(ADR 0029)。知识地图页改为浏览器:左侧是懒加载的树(展开时才请求子项),右侧是虚拟滚动的列表,支持游标分页、按默认顺序 / 标题 / 更新时间排序、按类型过滤、面包屑,以及在当前分类内搜索。打开叶子条目显示正文,人物与邮件还显示「也出现在…」。「问 AI」可以针对一个条目或整个分类新建会话,只把提示词填进输入框、不自动发送;提示词里的条目标题与摘要经过清洗与截断,并包成不可信数据,涉及邮件或联系人时会话视为读过不可信内容。手机宽度下树收进抽屉。无迁移,无新依赖(列表窗口在 `@fatcat-ai/ui` 中计算)。
- **接口**:新增 `POST /api/v1/items/{id}/ask`(请求体 `scope`:`item` 或 `subtree`;需要登录与 CSRF;返回 `201` 与 `sessionId`、`prompt`、`untrustedContentSeen`、`truncated`)。条目的读接口(`roots`、`search`、`{id}`、`children`、`ancestors`、`counts`、`subtree`、`related`)增加弱 `ETag`,`If-None-Match` 匹配时返回 `304`;不带该头的响应不变。客户端 SDK 增加 `items.ask`。
- **新增**:IM 里的 `/map` 指令(ADR 0029)。在绑定的微信里发 `/map` 浏览知识地图:回复编号(1–9)进入,`0` 或「返回」回上一层,「下一页」「上一页」翻页,再发 `/map` 回到顶层。列表只显示标题与计数;叶子只给标题、类型和一小段摘要,不发正文(请在 Web 打开)。只有整条消息就是编号或这几个词、在最近一次 `/map` 回复后 5 分钟内、且没有引用别人的内容才算应答,其余都是普通聊天;`/map` 的回复不写入会话。只读主人自己的条目,与 `/new`、`/help` 一样计入每分钟 20 条的限流。

#### 修复

- TOTP 两步验证不再能被无限次猜码:失败的验证码按用户名与按 IP 累计 24 小时,失败 10 次锁 15 分钟,20 次锁 1 小时,之后每多 10 次时长翻倍(最长 24 小时);只有验证成功才清零,锁定期间连正确的验证码也拒绝,每次锁定写一条警告日志。并发请求也不能在第一次失败被记下之前各猜一次(密码登录同样)。(来自 #35 的审查)
- `secrets rekey` 现在把 `backups/` 下所有加密备份一起用新密钥重新加密,逐个回读比对,任何一步失败就整体恢复;`secrets.yaml` 还是明文但已启用 TOTP 时也能运行(只重新加密数据库里的 TOTP 密钥)。`secrets migrate` 与 `secrets rekey` 在服务器运行时拒绝执行(服务器在数据目录写 `server.lock`)。`--plaintext-backups delete` 时输出的备份名是回滚副本 `secrets.yaml.migrated`;加密备份按时间戳只留最近 5 份。明文与密文并存时 `GET /api/v1/settings/secrets` 返回 409 并附处理办法,不再是 500。(来自 #32 的审查)
- `pnpm check:egress` 还能发现 `import https from 'https'`、`node:http2`、`require('net')`、不带括号传递或赋值的 `fetch`,以及 `ws`、`node-fetch`、`axios`、`got` 与 MCP SDK 的 sse / streamableHttp 客户端。内存检查(ADR 0018 规则 4)还会拦住每次只涨几 MiB 的慢泄漏。(来自 #34、#36 的审查)

### M5a · 渠道(进行中)

- **新增**:记忆召回不完整时,「本次用到的记忆」面板会说明,即使这一轮没有用到记忆,例如「向量检索超时,本轮只用了全文与关联检索,相关记忆可能不全」;嵌入密钥可能失效或嵌入接口拒绝请求时,说明里带设置页的链接。有相关记忆因预算没有展示时,显示未展示的条数(ADR 0017)。
- **新增**:API:`memory-used` 事件增加可选的 `degraded`(`[{ path, reason }]`,reason 为 `timeout`、`auth`、`rejected` 或 `error`)与 `omitted`;`POST /api/v1/memory/retrieve` 的结果增加 `degraded`。召回不完整时即使 `ids` 为空也发送 `memory-used`。没有嵌入配置档不算不完整。都是向后兼容的增量。
- **新增**:服务器写一行本地日志 `memory.retrieve.degraded`,只记路径、原因、耗时、运行 id,嵌入接口出错时另记 HTTP 状态码;不记查询文本、记忆内容或错误原文。
- **新增**:设置页「通用」里可以搜索选择时区(ADR 0023);留空时跟随服务器,页面上显示服务器时区。邮件工具的「今天」、`time` 工具的默认时区、每天 03:30 的记忆维护与附件清理、嵌入与自动抽取的每日上限都改为按你的时区(Docker 里服务器通常是 UTC)。改时区后定时任务立即重新排期,当天已完成的任务不会再跑一次。
- **新增**:系统提示最后一行是你所在时区的当前时间,精确到分钟,例如「当前时间:2026-11-11 15:30(Asia/Shanghai,星期三)。」
- **新增**:API:`Settings.timeZone`(IANA 名如 `Asia/Shanghai`,或 `UTC`;`null` 表示跟随服务器);`GET /api/v1/settings/time-zones`(需要登录)返回 `serverTimeZone` 与 `supported` 列表。`+08:00` 这类固定偏移和 `CST` 这类缩写返回 400。都是向后兼容的增量。
- **新增**:渠道框架(ADR 0022),是在 IM 里使用助手的基础;微信适配器本身在之后的更新里加入。设置页「渠道」可以列出、启用 / 停用渠道,生成一次性的 6 位配对码(10 分钟有效,输错 5 次作废),查看绑定的主人账号(只显示末 4 位)并解除绑定,查看最近错误与忽略 / 限流计数,并打开「记忆召回连续不完整时在 IM 里提醒」(默认关;10 分钟内 3 次提醒一次)。
- **新增**:微信渠道(腾讯 iLink 机器人接口,ADR 0024),只按腾讯公开的协议说明实现。扫码登录(`POST`/`GET /api/v1/channels/{id}/wechat/login`,新增接口)后,服务器长轮询收消息、用纯文本回复,断线按指数退避重连(最长 5 分钟);登录失效时渠道显示「需要登录」,重新扫码即可。登录令牌写进数据目录 `secrets.yaml` 的 `ILINK_TOKEN_<渠道 id>`:写入前先把文件复制到 `backups/secrets-<UTC 时间>.yaml`(只留最近 5 份),只改这一行,文件解析失败时不写;删除渠道时同样只删这一行。暂不支持:图片、文件与语音音频(有语音转文字时使用转文字结果),以及需要输入 PIN 的登录。
- **新增**:IM 里只有绑定的主人的私聊消息会交给助手,其他人的消息与群聊消息一律忽略、不回复。指令:`/new`、`/clear`(或「清空」)、`/source`、`/help`。`/clear` 只删除这个渠道的当前会话:先停掉正在进行的回复,删掉该会话的附件文件,不删除记忆,也不动其他对话,不需要审批短码。需要确认的操作会推送「需要确认:…回复「确认 K7」或「拒绝 K7」」;只认主人私聊里整条就是这条指令的回复,短码随审批过期,审计与 Web 审批相同,另注明「(via channel …)」。转发的聊天记录、引用的消息与链接卡片按不可信内容处理,与邮件相同。回复转成纯文本并按长度切成带序号的多条。重复投递的消息会被丢弃(记录保留 3 天),主人每分钟最多 20 条,会话忙时最多排队 5 条。
- **新增**:会话列表里每条对话都可以删除,另有「清空全部对话」(确认框写明记忆会保留)。`DELETE /api/v1/sessions` 删除当前登录主人的全部对话:先停掉进行中的运行,附件文件与删除单条对话时一样删除,记忆保留。其他主人的数据不动。这是向后兼容的增量。客户端 SDK 增加 `sessions.clear()`。
- **新增**:API:`GET/POST /api/v1/channels`、`GET/PATCH/DELETE /api/v1/channels/{id}`、`POST /api/v1/channels/{id}/pairing`、`DELETE /api/v1/channels/{id}/binding`、`GET /api/v1/channels/{id}/status`(都需要登录);`GET /api/v1/meta` 的 `capabilities` 增加 `channels`。数据库迁移 0014 新增渠道相关的表(与每次迁移一样先备份数据库)。都是向后兼容的增量。
- **修复**:知识地图括号里的数字改为这一层里的内容条数(记忆、邮件、会话、文件等),不再把分类文件夹和隐藏的历史版本算进去,与展开后看到的一致(ADR 0025)。同时在收件箱和已发送里的邮件(例如发给自己的)两边都会列出,已发送不再是 0。任务类记忆(episodic/task、semantic/task)仍在「经历」或「事实」下;展开时重新加载,新写入的记忆会马上出现。条目标题改为左对齐。
- **修复**:在 Windows 上,`secrets.yaml` 和同一次写入产生的备份不再沿用用户配置文件里继承来的访问权限。每次写完后用 `icacls`(不经过 shell)去掉继承项,只给当前用户完全控制。失败时保留文件并记一条警告。
- **修复**:微信长轮询之间、以及扫码状态立刻返回时的 1 秒间隔,在停止渠道或进程退出时会马上结束,不再干等。
- **修复**:按住说话时,如果录音中途标签页切到过后台(那段时间采不到电平),即使前半段是在前台录的,也不再被当成静音丢掉。
- **修复**:渠道审批的四处缺口(ADR 0022)。IM 里的审批提醒现在会列出这个审批的警告,每条一行「注意:…」(例如邮件发给了不是来自你自己消息的收件人);提醒太长时只截断警告,不截断「回复『确认 K7』或『拒绝 K7』」这一句。在 Web 上批准或拒绝之后,IM 再回这个短码会得到「已处理。」而不是「没有这个待确认项。」,也不会再执行一次;别的渠道的短码、过期的短码和重启之前的短码仍然是「没有这个待确认项。」。带引用或转发的消息即使正文整条是「确认 K7」也不算审批,会作为普通消息交给助手,引用部分按不可信内容标出。渠道未绑定时,错误、过期或在 5 次锁定之后发来的配对码不再回复,并计入每分钟的忽略类消息上限;正确的码仍回「已绑定。」。
- **修复**:渠道:只出现在转发、引用或链接卡片块里的地址,不再算 `mail.send` 的可信收件人(ADR 0016 第 7 节、ADR 0022 第 14 节)。可信的只有你自己打的字,以及被回复邮件的发件人 / Reply-To;检查前会先去掉渠道拼进消息的不可信块(你自己打出形似块的行也会被去掉,最多多出一条警告),已有的会话同样适用。IM 里的审批提醒因长度丢掉警告时,会多一行「还有 N 条警告,请在 Web 查看。」,回复那一句不会被截断。

### M4 · 语音与图片(2026-11-10)

已完成。业主侧在 Windows 上的测试(2026-11-10)用 DeepSeek(`deepseek-flash`)聊天与看图、硅基流动语音(`Qwen/Qwen3-ASR-1.7B`、`FunAudioLLM/CosyVoice2-0.5B`):MP3、WebM、Ogg、WAV 四种录音的转写、朗读与看图都正常;用真实麦克风时转写结果不对(出现别的语言),同样格式的合成音频都能正确转写,判断是那台机器的麦克风输入问题,用户决定按通过处理。Firefox 未测。详见 `docs/milestones/M4-self-check.md`。CI 中用假端点测得,一次语音往返(录音 → 回复 → 开始朗读)FatCat-AI 自身只多约 15 ms,远低于 1 秒的目标;空闲内存不变,约 110 MiB。

- **新增**:聊天中可以用「图片」按钮、粘贴或拖放给一条消息附上最多 4 张图片(PNG、JPEG、WebP、GIF,每张 ≤ 5 MiB;ADR 0020),发送前有预览、可移除。上传前浏览器会把长边缩到 2048 px 以内,顺带去掉 EXIF(含 GPS 位置);GIF 原样上传。发出的图片显示在对话里,只有你自己能看到。
- **新增**:设置 → 模型配置档中加入「支持图片」勾选框,只有确认模型能读图时才勾选,FatCat-AI 不会自己猜。当前配置档没勾时,聊天里会说明不能发图片的原因;服务器也会返回 `model_no_vision` 拒绝,而不是悄悄丢掉图片。
- **新增**:三种模型接口(OpenAI 兼容、Anthropic、Gemini)都支持图片。每个会话只把最近 8 张图片重新发给模型,更早的以及被自动压缩的历史中的图片换成「[图片:文件名]」。
- **新增**:API 增加 `POST /api/v1/attachments`(multipart 上传)与 `GET /api/v1/attachments/{id}`;发送消息时可带 `attachmentIds`;消息多了 `image` 段;配置档多了 `vision`;新错误码 `model_no_vision`、`payload_too_large`、`unsupported_media_type`。类型按文件开头的字节判断,不看文件名。都是向后兼容的增量。
- **新增**:语音接口(ADR 0021):`POST /api/v1/voice/transcriptions` 把录音(WebM、Ogg、MP4/M4A、WAV、MP3,≤ 10 MiB)转成文字,`POST /api/v1/voice/speech` 把最多 4,000 字朗读成 MP3、Opus 或 WAV 音频流。两者都用 purpose 含 `stt` / `tts` 的配置档,且必须是 OpenAI 兼容;密钥只在服务器。每个用户每分钟各 20 次。录音、转写文字与朗读文字都不保存、不写日志,日志只记配置档、大小与耗时。
- **新增**:设置中加入 `voice` 一组(`defaultSttProfileId`、`defaultTtsProfileId`、`autoSend`、`autoSpeak`),配置档的 `params.voice` 填 TTS 音色(默认 `alloy`)。客户端 SDK 增加 `voice.transcribe()` 与 `voice.speak()`。
- **新增**:聊天中的「按住说话」按钮:按住(或在输入框外按住空格键)说话,松开后转写;轻点一下开始语音消息,再点一下结束。录音最长 120 秒。默认转写后直接发送,在设置 → 语音中关掉「自动发送」则只填进输入框。回复旁有「朗读」按钮,打开「回复结束后自动朗读」则每条回复都会读出来;代码块读成「(代码已省略)」,链接只读文字。
- **新增**:语音状态指示器:一个小的粒子球加一行状态文字(空闲、正在听、正在思考、正在朗读,或正在使用的工具,例如「正在读取网页…」)。说话或朗读时随音量脉动;所有打开的页面与设备显示同一个状态;系统要求减少动态效果时显示静止的圆,浏览器画不出来时只显示文字。
- **新增**:设置 → 语音:选择语音转文字与朗读的配置档,以及上面两个开关。配置档表单的用途可以勾选 `stt` / `tts`,并可填写朗读音色。
- **新增**:API:WebSocket 客户端帧 `voice-state`(浏览器上报正在听 / 正在朗读 / 结束,服务器转成 `assistant-state` 事件推给你所有的端);`assistant-state` 事件带界面语言的 `label`;工具带 `activityLabel`。
- **修复**:编辑模型配置档时,如果这次修改没有带上「支持图片」,它不再被清掉。
- **新增**:配置档可选的 `params.voiceProtocol`(`openai` / `openai-chat` / `volcengine`,默认 `openai`),选择语音配置档调用服务的方式。目前只实现 `openai`,其他取值先预留,实现前会以 `validation_failed` 拒绝。
- **变更**:按住说话时,短于半秒或几乎无声的录音不再发去转写,直接提示「没有听清」;转写模型遇到几乎无声的录音时常会胡乱输出别的语言。
- **修复**:朗读切句时也识别全角的 ！？； 和后面跟空格的英文句号(数字与网址里的点不切);不再删掉 `snake_case`、`__init__` 这类名字里的下划线。
- **修复**:停止朗读后,正在预取的那一段不再在浏览器控制台留下未处理的错误。
- **修复**:关掉一个标签页时,如果另一个标签页还在听或朗读,其他端的语音指示器不再被重置为空闲。
- **修复**:代码高亮加载失败一次(例如断网)后,下一个代码块会重新加载。
- **修复**:图片文件名中的零宽字符等不可见格式字符也会被去掉(此前已去掉控制字符与双向控制字符)。
- **变更**:数据目录多了 `attachments/` 文件夹,删除会话时一并删除其中的图片;上传后从未发送的图片 24 小时后清理。自己备份数据目录时请连同这个文件夹一起备份。首次启动会执行数据库迁移 0013。

### M3.x · 清理

- **新增**:设置 → 邮件账户中,每个账户有「已发送」副本开关(`sentCopy`:自动 / 总是保存 / 不保存,ADR 0016 第 14 节),并说明所选策略下「已发送」副本怎么处理;在 163 / Gmail 上选「总是保存」会提示每封邮件会出现两份(这两家服务器本身会保存)。出错时错误显示在对应账户的卡片里。以前只能通过 API 修改。
- **新增**:设置 → 通用中加入「自动抽取记忆」开关(`memory.autoExtract`,默认关)。开启时记忆页顶部有提示和一键关闭按钮;关闭不影响已保存的记忆。
- **新增**:记忆页每条记忆有「生成来源」按钮,列出它的出处;自动抽取的记忆显示模型、成功或失败(带错误码)、时间与提示词版本(ADR 0007 第 5.9 节),其他出处说明没有生成记录。自动抽取开关保存期间禁用。
- **新增**:聊天中写明语言的代码块(如 ` ```ts `)有语法高亮,深浅色都适配;支持 14 种常用语言,没写语言的代码块仍是纯文本。高亮代码在第一次出现这样的代码块时才加载。
- **修复**:大量同步邮件后内存能回落了。以前同步 1 万封后服务器停在约 265 MiB 不下降;现在稳定在约 141–145 MiB,反复同步也不再上涨。原因是 V8 新生代涨到约 128 MiB 后不归还,以及 SQLite 页缓存 16 MiB 填满后一直占着。服务器现在用 `--max-semi-space-size=8` 限制新生代,SQLite 页缓存改为 4 MiB。Docker 镜像(`NODE_OPTIONS`)、`pnpm dev` 与 `pnpm --filter @fatcat-ai/server start` 都会自动带上这个参数,Windows 下也一样;只有自己直接运行 `node apps/server/dist/index.js` 时才需要手动加。
- 新增 `pnpm perf:mail-sync`:用本地假 IMAP 服务器与合成邮件测这项内存(Linux 与 Windows;先 `pnpm build` 后自己起服务器,或用 `ATTACH=<地址>` 测已在运行的服务器,如 `pnpm dev`)。上面的数字来自 Linux 主机上的这套合成环境,不是 Docker 容器。

### M3 · 邮件(2026-11-05)

- **邮件账户**(ADR 0016):在「设置 → 邮件账户」添加 IMAP/SMTP 账户,有 QQ、163、Gmail 预设;密码(应用专用密码或授权码)只能用 `env:NAME` 或 `file:NAME` 引用,不存明文;只支持 TLS 与 STARTTLS,不支持 OAuth;「测试连接」分别检查 IMAP 与 SMTP 登录,不发信。
- **同步**:默认每 5 分钟同步收件箱与已发送,首次只拉最近 30 天(`initialSyncDays`);已读状态与删除跟随服务器,读取正文一律用 `BODY.PEEK`,不会把邮件标为已读;登录后发送 IMAP `ID` 命令(163 需要);本地缓存邮件头、纯文本正文与附件索引,附件只在你要求时下载;同步在短时的子进程中进行,没有配置账户时空闲内存不变。
- **邮件工具**:`mail.list`(含「今天未读」)、`mail.search`、`mail.read`、`mail.summarize`(只读,输出标为不可信)、`mail.draft`(只存本地草稿)与 `mail.send`(只发送已保存的草稿,每次都要你批准,不能预授权)。审批等待期间草稿被修改时,原审批作废。发出后「已发送」中的副本由服务器自动保存或由 FatCat-AI APPEND(见下方「修复」)。
- **会话级污染**:会话中只要有工具返回过不可信内容(网页、文件或邮件),整个会话就一直视为被污染,重启后仍然有效。被污染的会话中条件预授权全部失效(`memory.write` 一定要审批);收件人既不是你在本会话中亲自输入的地址、也不是被回复邮件的发件人时,审批卡片会标红显示 `recipient_untrusted` 警告。
- `pnpm eval` 增加 14 条邮件注入用例。
- **知识地图与 Web 中的邮件**:知识地图显示「邮件 → 账户 → 文件夹 → 会话串 → 邮件」,正文不进条目搜索;新的「邮件」页可按账户与文件夹浏览、立即同步、查看纯文本正文,以及查看、修改、删除草稿;附件(`.md`、`.txt`、`.pdf`、`.docx`、`.xlsx`,不超过 20 MB)可「加入知识库」,与文件相同地做凭据检测后供 `kb.search` 检索,只保存分块;单封邮件上的「问 AI」新建一个从一开始就视为被污染的会话,预填的提示只含邮件 id。
- 新增 `/mail` 下的端点:预设、账户(含文件夹、测试与同步)、邮件、问 AI、附件加入知识库与草稿。
- **修复**:用 163 账户发信后「已发送」不再有两份。163(与 Gmail 一样)会由服务器自动保存经 SMTP 发出的邮件,FatCat-AI 又 APPEND 了一份。账户新增「已发送」副本策略 `sentCopy`(ADR 0016 第 14 节):默认 `auto`,对 `imap.163.com` 与 `imap.gmail.com` 不 APPEND(交给服务器),其他主机(含自定义主机)APPEND;`append` / `off` 在任何主机上总是 / 从不 APPEND,`appendToSent` 设为 `true` / `false` 等同于它们,显式设置不会被主机覆盖。账户响应带 `sentCopy`,`appendToSent` 表示该账户发送后 FatCat-AI 是否会 APPEND。`mail.send` 结果中的 `savedToSent` 只表示 FatCat-AI 自己的 APPEND 成功,服务器自动保存的那一份不核实;新字段 `sentCopy` 说明这一次的处理(`append`、`append-failed`、`server`、`off`、`no-sent-folder`)。已经产生的重复不会自动删除。
- **升级**:旧账户分不清默认值与用户选择,`appendToSent: true` 记为 `auto`,`false` 记为 `off`;只有 163 / Gmail 上原为 `true` 的账户停止 APPEND,需要时把 `sentCopy` 设为 `append`。同时在收件箱与已发送中的邮件(例如发给自己的)现在在两边的筛选以及「今天未读」中都能看到。
- 说明:「今天」按服务器时区(容器的 `TZ`)计算;用「总是允许」保存的预授权(如某目录的 `fs.write`)在被污染的会话中仍然有效,请谨慎设置;联系人与「人物」推迟到 M5,Gmail/Outlook OAuth、IDLE、HTML 富渲染、定时摘要、标为已读等写操作、其他文件夹与附件自动入库推迟;无邮件账户时 CI 中 Docker 镜像空闲内存为 110 MiB(门禁 120 MiB)。自检报告见 [docs/milestones/M3-self-check.md](docs/milestones/M3-self-check.md)。

### M2 · 工具与文件(2026-11-05)

- **工具框架与审批**(ADR 0010):
  - 每个工具有风险级别(只读 / 写入 / 对外发送 / 危险),决定是直接执行还是需要你批准;
  - 审批请求会保存,30 分钟后过期;
  - 批准时可以选「本会话内总是允许」或「总是允许」(对外发送与危险工具除外);
  - 预授权在设置中可以查看和撤销;
  - 任何会话的待审批操作都会显示在 Web UI 顶部的面板中;
  - 本机审计日志(Web UI → 审计)记录写入、对外发送、被拒绝的调用与预授权变化,入参已脱敏。
- 新端点 `GET /tools`、`GET /approvals`、`GET` / `DELETE /preauthorizations`、`GET /audit`;`POST /approvals/{callId}` 可带 `remember`。
- **内置工具**:
  - `time`(任意 IANA 时区的当前时间);
  - `calc`(自写解析器的精确计算,不用 `eval`);
  - `web.fetch`:
    - 读取网页正文,标记为不可信内容;
    - 需要审批,只能按域名预授权;
    - 拒绝回环、私网、链路本地与云元数据地址(DNS 解析与跳转后同样校验);
    - 响应上限 2 MB、15 秒。
- **文件工具**(ADR 0011):
  - `fs.list`、`fs.read`、`fs.search`(只读)与 `fs.write`、`fs.move`(写入,需审批)只能在设置 → 授权目录中授权的文件夹内使用。
  - 检查前先把路径解析为真实位置(链接、junction、Windows 8.3 短名)。
  - 拒绝备用数据流、设备名、UNC 路径以及以点或空格结尾的名称。
  - 写入是原子的,默认不覆盖。
  - 写入审批只能按文件夹记住。
  - 越权的尝试会写审计。
- **知识地图数据层**(ADR 0012):授权目录中的文件、识别出的小说(书 → 章,UTF-8 或 GB18030)与会话登记为条目,计数保持一致;`/api/v1/items/*` 提供顶层类别、子项、祖先、计数、子树、搜索与增量变更,打开时重新校验文件权限;只读的 `items.*` 工具让模型也能浏览;Web UI 有最简的树形浏览;撤销授权目录时对应条目软删除。
- **文档读取**:`fs.read` 把 PDF、DOCX、XLSX 转为文本,并标注 PDF 页码与 XLSX 工作表名。解析在短时的 worker 线程中进行,有内存与时间上限,空闲内存不变。拒绝加密文档与 ZIP 炸弹。
- **MCP 客户端(仅 stdio)**(ADR 0013):在「设置 → MCP 服务器」或 `/api/v1/mcp/servers` 添加本机 MCP 服务器。它的工具以 `mcp.<服务器>.<工具>` 出现,不论服务器如何声明,默认都需要你批准;可以通过 API 按工具设置级别。命令不经过 shell 运行,只拿到最少的环境变量加上你列出的变量名(永远不含 `AIP_*`),不保存任何值。输出(包括错误文本)标为不可信。删除服务器时一并删除它的预授权。只有配置了服务器才加载客户端代码,空闲内存不变。Streamable HTTP 推迟。
- **嵌入与向量索引**(ADR 0014):带 `embed` 用途的 OpenAI 兼容配置档现在可以通过 `/embeddings` 嵌入文本。向量用 sqlite-vec 保存,表的维度取自配置档,条目删除时向量一并删除。后台队列每次处理一批,失败后退避重试,到达每日上限(默认 5,000 条)后停止。更换嵌入模型或维度后,「设置 → 向量索引」会提示重建。新增 `GET /embeddings/status` 与 `POST /embeddings/rebuild`。只有存在 embed 配置档或以前建过向量索引时才加载 sqlite-vec。知识库与记忆检索会在后续 PR 中使用它。
- **本地知识库**(ADR 0015):授权目录中的 Markdown、文本、PDF、DOCX、XLSX 按标题与段落分块,并保留 PDF 页码。块大小可在设置中调整(默认 1,000 字符)。存在 embed 配置档时分块会被嵌入。新工具 `kb.search`(read)优先用向量检索,没有向量时退回全文检索;它返回带文件名与页码的编号片段,Web 中显示为引用。索引是增量的;删除文件或撤销授权目录后,它的分块与向量会被清理。
- **记忆 v2 基础**(ADR 0007 第 5 节):数据库迁移到记忆 v2 的结构,不重建 M1 的表,迁移前自动备份。已有记忆的正文不变,并出现在知识地图中:「记忆 → 域 → 类型」,被更替的旧值放在隐藏的「历史版本」下,并链接到更替它的新值。新增记忆 v2 的契约类型与 `memory-used` 事件;`memory.save` / `memory.search` 的行为暂时不变。
- **记忆写入路径**(ADR 0007 第 5.5 节):
  - 凭据(API key、令牌、JWT、私钥、密码、连接串、TOTP 种子、高熵串)在落库前一律拒存;
  - 银行卡号、身份证号、手机号与详细住址在写入前替换为占位文字;
  - entity_key 规范化;重复的事实合并;单值键的新值更替旧值,新值把握不够时两条都标为冲突;
  - 来自外部、不合法、过长或像指令的内容进隔离区(保留 14 天),不进记忆。
- 新工具 `memory.write`(`memory.save` 成为它的别名):由你本人的消息触发、不涉及敏感内容、不更替画像事实时直接写入,其余情况需要审批;设置 `memory.alwaysApprove` 可改为每次都审批。
- 每轮结束后的自动抽取(默认关闭;`memory.autoExtract`,每天最多 `memory.extractDailyLimit` = 200 次 cheap 模型调用):只读你的消息和最终回答,不读工具输出;读过外部内容的那一轮只把建议放进隔离区。
- **记忆检索**(ADR 0007 第 5.6 节):相关记忆现在会自动加进对话。召回结合全文检索(含中文二字词回退)、有 embed 配置档时的向量检索,以及关联条目;每条带可信度标签(可靠 / 可能过时 / 有冲突 / 推断),分数最高的几条附出处。记忆块不超过 `memory.blockTokens`(默认 1,200 tokens,且不超过模型上下文的 10%)。每个会话开头注入一段 digest:置顶记忆、画像事实、已接受的决策与待确认的冲突(`memory.digestTokens`,默认 400)。
- 新工具 `memory.retrieve`(`memory.search` 成为它的别名),新端点 `POST /memory/retrieve` 与 `GET /memory/digest`;每轮会发送 `memory-used` 事件,列出用到的记忆。
- **记忆维护**(ADR 0007 第 5.7 节):每天 03:30(服务器时间)按类型衰减(经历半衰期 30 天、方法 180 天、事实 365 天、已完成的决策 90 天;置顶与画像事实不衰减)。很少用到的记忆先转为 cold 再转为 archive,归档的记忆删除向量但仍可全文检索;超过有效期的事实标为过期。再次用到时回到 active。任务分小批执行,有对话进行中时等待。
- **记忆反馈与管理**(ADR 0007 第 5.8 节):回答之后,「本次用到的记忆」列出助手看到的记忆,可以点有用、过时、错误(可填写更正,立即替换)或不该记(删除);记忆页显示每条记忆的历史、待确认的矛盾(保留一条、两条都对或忽略)和隔离区(可以确认保存);记忆出现在知识地图「记忆 → 域 → 类型」中,旧版本默认隐藏。
- 新端点 `POST /memory/{id}/feedback`、`GET /memory/{id}/sources`、`GET /memory/{id}/history`、`GET /memory/conflicts`、`POST /memory/conflicts/{id}/resolve`、`GET /memory/quarantine`、`POST /memory/quarantine/{id}/promote`;`GET /items/{id}/children` 新增 `includeHidden`。新工具 `memory.digest`、`memory.feedback` 与 `memory.forget`(每次都要审批)。
- 撤销新记忆与「忘记」记忆现在都会写入审计日志(只记记忆 id)。
- **按目录选择是否进入知识库**(ADR 0015 第 6 节):设置中每个授权目录都有「加入知识库」开关(`PATCH /fs/roots/{id}`,`knowledgeBase`),默认关闭;关闭后清理该目录的分块与向量。升级后所有目录默认不在知识库中,已有分块会在下一次索引时清理,需要重新勾选。
- **凭据不进知识库**(ADR 0015 第 7 节):分块入库前,API key、令牌、密码等凭据替换为「[已隐藏凭据]」,替换后仍像凭据的块整块丢弃。
- `pnpm eval` 运行记忆评测集(32 条中文用例,覆盖召回、更替、冲突、注入、凭据与过时说明),回放模式,输出召回率、过时率与错误率。
- 中文二字词召回不再丢掉「过敏」「吉他」这类实词。
- `memory.search` 带查询而没有命中时,不再回退为最近 20 条;空查询仍列出最近的记忆。
- 服务器重启时尚未处理的审批请求会过期,不再悄悄丢失。

### M1 · 对话核心(2026-11-04)

- **自带模型**:任意 OpenAI 兼容端点(OpenAI、DeepSeek、OpenRouter、Ollama、LM Studio、vLLM 等)以及 Anthropic、Gemini 原生接口,均为流式;配置档有用途(对话 / 廉价摘要)、连接测试,并可在设置中指定默认配置档。
- **密钥不落明文**:配置档只能用 `env:NAME` 或 `file:NAME`(数据目录下的 `secrets.yaml`)引用密钥,`keyStatus` 显示是否找到;日志、错误与录制数据中的密钥一律脱敏。
- **版本化 API `/api/v1`**:主人初始化(仅本机或凭一次性设置码)、密码登录(Cookie 会话 + CSRF)、个人访问令牌、登录限速、problem+json 错误、需鉴权的 OpenAPI 3.1 文档;除 3 个公开端点外,未登录一律 401。
- **会话与运行**:SSE 流式回复与连接解耦,可用 `Last-Event-ID` 续看;支持中断、重试、重新生成(旧回复保留为分支)、幂等发送;WebSocket 事件通道断线后按 `lastSeq` 补发。
- **工具与审批**:需要审批的工具调用会暂停运行,等你批准或拒绝。
- **记忆 v1**:助手可调用 `memory.save`(需批准)与 `memory.search`,凭据拒存;可通过 API、命令行和 Web UI 查看、搜索、编辑、撤回、删除记忆;长会话用廉价配置档压缩,原文始终保留。
- **存储**:数据目录中的单个 SQLite 数据库,版本化迁移,迁移前自动备份,强制外键约束。
- **客户端 SDK `@fatcat-ai/client`**(Apache-2.0,零运行时依赖)与 **`fatcat-ai` 命令行**。
- **Web UI**:初始化与登录、会话列表、流式 Markdown 聊天(刷新页面后续看)、批准 / 拒绝按钮、设置(中英文、深浅色、默认配置档)、模型配置档管理、记忆页。
- 说明:1.0 只有一个主人账户;默认只监听 127.0.0.1;Docker 镜像空闲内存低于 120 MiB(CI 中为 95 MiB)。

### M0 · 工程脚手架(2026-11-03)

- 单仓工程与工具链、最小 server 与 Web 壳、双许可与合规文件、CI 检查、Docker 镜像与内存门禁。
