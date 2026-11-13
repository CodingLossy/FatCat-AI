# Changelog

All notable user-visible changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no tagged releases yet: version numbers start with the first release (planned for M5), so everything below is under "Unreleased", grouped by milestone. A Chinese summary follows the English text (中文摘要见下方).

## [Unreleased]

### Renamed to FatCat-AI

The project was renamed from AI-Personal to FatCat-AI and moved to <https://github.com/CodingLossy/FatCat-AI> (ADR 0019).

#### Changed

- Packages are now `@fatcat-ai/*`, the CLI command is `fatcat-ai`, and the Docker image is `fatcat-ai`. The client SDK exports `FatCatClient`, `FatCatApiError` and `FatCatNetworkError`.
- The default data directory is `~/.fatcat-ai`. On the first start, the server moves an existing `~/.ai-personal` there (a rename, or a verified copy across drives); it never overwrites an existing `~/.fatcat-ai`. Docker keeps `/data` and the `ai-personal-data` volume.
- The docker compose service is now `fatcat-ai` instead of `ai-personal`. If you already run it with compose, run `docker compose -f docker/docker-compose.yml down` with the old compose file before upgrading, or start the new version with `docker compose -f docker/docker-compose.yml up -d --build --remove-orphans`; otherwise the old container keeps holding port 8787. Your data stays in the same volume.
- If the old server is still running on Windows, the data directory can't be moved (`EPERM` / `EBUSY`). The server retries for a few seconds, then exits with a message asking you to stop the old AI-Personal server first; nothing is moved or deleted.
- Environment variables now start with `FATCAT_AI_` instead of `AIP_` (for example `FATCAT_AI_PORT`, `FATCAT_AI_DATA_DIR`, `FATCAT_AI_TOKEN`). The old names still work for now and print a deprecation warning.
- Unchanged on purpose: the `aip_pat_` token prefix, the `aip_session` / `aip_csrf` cookies and the `X-AIP-Server-Version` header, so existing tokens and API v1 clients keep working.

### M5b · Secrets, TOTP and the knowledge map (in progress)

#### Added

- Secrets encryption (ADR 0026). `secrets.yaml` can now be encrypted as a whole into `secrets.yaml.enc` (AES-256-GCM, envelope `fcsec1`). It is never done automatically: use Settings → Secrets (status, master key source and fingerprint, a confirmation step, and what to do with existing plaintext backups: keep, encrypt or delete) or the offline commands `node dist/index.js secrets migrate`, `secrets rekey --new-key-file <file>` and `secrets cleanup`. Migration backs up, writes and verifies the encrypted file, and only then renames the plaintext file to `secrets.yaml.migrated`; any failure leaves the plaintext untouched. The master key comes from `FATCAT_MASTER_KEY`, `FATCAT_MASTER_KEY_FILE` or a generated `master.key` (mode 600). A fresh install writes the encrypted file from the first secret on. If the master key is missing or does not match, the server still starts and features that need secrets report "密钥不可用" without any file being changed. `master.key`, `secrets.yaml.enc` and `secrets.yaml.migrated` are never committed (`pnpm check:secrets`).
- API: `GET /api/v1/settings/secrets` and `POST /api/v1/settings/secrets/migrate` (body `confirm: true`, optional `plaintextBackups`: `keep`, `encrypt` or `delete`); neither returns any secret value. Both additive.

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

### 改名为 FatCat-AI

项目由 AI-Personal 改名为 FatCat-AI,仓库迁到 <https://github.com/CodingLossy/FatCat-AI>(ADR 0019)。

- 包名改为 `@fatcat-ai/*`,命令改为 `fatcat-ai`,Docker 镜像改为 `fatcat-ai`;客户端 SDK 导出 `FatCatClient`、`FatCatApiError`、`FatCatNetworkError`。
- 默认数据目录改为 `~/.fatcat-ai`。首次启动时服务器把已有的 `~/.ai-personal` 迁过去(重命名,跨盘时复制并校验);已有 `~/.fatcat-ai` 时不覆盖。Docker 仍用 `/data` 与 `ai-personal-data` 卷。
- docker compose 服务名由 `ai-personal` 改为 `fatcat-ai`。已经用 compose 部署过的,升级前先用旧版的 compose 文件执行 `docker compose -f docker/docker-compose.yml down`,或者升级后用 `docker compose -f docker/docker-compose.yml up -d --build --remove-orphans` 启动,否则旧容器会一直占着 8787 端口;数据仍在原来的卷里。
- Windows 上旧服务器仍在运行时,数据目录无法迁移(`EPERM` / `EBUSY`)。服务器会重试几秒,仍失败就提示先停止旧的 AI-Personal 服务器并退出,不移动也不删除任何文件。
- 环境变量前缀由 `AIP_` 改为 `FATCAT_AI_`(如 `FATCAT_AI_PORT`、`FATCAT_AI_DATA_DIR`、`FATCAT_AI_TOKEN`);旧名暂时仍可用,并打印弃用警告。
- 有意不改:令牌前缀 `aip_pat_`、Cookie `aip_session` / `aip_csrf` 与响应头 `X-AIP-Server-Version`,现有令牌与 API v1 客户端不受影响。

### M5b · 密钥、TOTP 与知识地图(进行中)

- **新增**:密钥加密存储(ADR 0026)。`secrets.yaml` 可以整体加密为 `secrets.yaml.enc`(AES-256-GCM,信封 `fcsec1`),不会自动进行:在「设置 → 密钥」查看状态、主密钥来源与指纹,确认后迁移(并选择已有明文备份保留、加密或删除),或用离线命令 `node dist/index.js secrets migrate`、`secrets rekey --new-key-file <文件>`、`secrets cleanup`。迁移顺序为备份、写入并回读校验加密文件,全部通过后才把明文改名为 `secrets.yaml.migrated`,任何一步失败都保留明文原样。主密钥来自 `FATCAT_MASTER_KEY`、`FATCAT_MASTER_KEY_FILE` 或自动生成的 `master.key`(权限 600)。全新安装从第一个密钥起就写加密文件。主密钥缺失或不匹配时服务器照常启动,依赖密钥的功能报「密钥不可用」,不改动任何文件。`master.key`、`secrets.yaml.enc`、`secrets.yaml.migrated` 不会进仓库(`pnpm check:secrets`)。
- **接口**:新增 `GET /api/v1/settings/secrets` 与 `POST /api/v1/settings/secrets/migrate`(请求体 `confirm: true`,可选 `plaintextBackups`:`keep` / `encrypt` / `delete`),响应里没有任何密钥值;均为增量。

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
