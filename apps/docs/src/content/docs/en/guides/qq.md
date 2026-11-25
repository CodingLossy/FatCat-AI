---
title: Connect QQ
description: Connect the assistant to a QQ official bot with its credentials, pairing and approvals from QQ.
---

> English version translated by a model; pending review.

The QQ channel uses an official bot on the QQ open platform and handles direct (one-to-one) chats only; messages that @ the bot in a group are ignored. Binding, commands and approvals work exactly as in the [WeChat channel](/en/guides/channels/), and each channel accepts exactly one owner account.

## Prepare the bot

1. Create a bot on the [QQ open platform](https://q.qq.com/).
2. Find the **AppID** and **AppSecret** under the bot's development settings.
3. Turn on direct messages for the bot and add your own QQ account as a user who may chat with it (before the bot is published, only users configured in its sandbox can talk to it).

## Steps

1. **Enter the credentials.** Settings → Workbench → Channels: pick "QQ" as the type and add it, click "QQ bot credentials", enter the AppID and AppSecret, save, then click "Enable".
2. **Pair.** Click "Create pairing code" and, from **your own** QQ account, send 「绑定 123456」 (use the code shown on the page) to the bot in a direct chat. After that only your direct messages reach the conversation.
3. **Approve actions from QQ.** Actions that need approval are sent to QQ; reply 「确认 K7」 or 「拒绝 K7」 (use the code in the message).

## Where the AppSecret is stored

The AppSecret is stored in `secrets.yaml` in the data directory (key `QQBOT_SECRET_<channel id>`) with the same rules as the WeChat login token: the file is backed up to `backups/` first, only that line changes, and nothing is written if the file doesn't parse. The page and the API never show it again; deleting the channel removes only that line. The access token obtained while connecting stays in memory, is never written to disk and never appears in logs.

## Connection and sending

- The assistant connects out to the QQ WebSocket gateway (`api.bot.qq.com`), so no public address is needed and it works on your own machine.
- Replies use QQ's passive replies first (within 60 minutes of your message, at most 4 per message) and fall back to proactive messages after that. Scheduled-task pushes to QQ are proactive messages, at most 1000 per user per day; if you turn off "allow proactive messages" in QQ, pushes fail and the task run shows QQ's error code.
- "Needs bot credentials" means none were entered or QQ rejected them; "The bot may not receive direct messages" means the direct-message permission must be turned on at the open platform.

## Current limits

Group chats, guild channels, images and files, and Markdown messages are not supported yet; voice messages use only the text QQ provides.
