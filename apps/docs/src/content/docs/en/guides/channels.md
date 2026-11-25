---
title: Connect WeChat
description: Connect the assistant to WeChat with QR login, pairing and approvals from WeChat.
---

1.0 includes only the WeChat channel; for the QQ official bot see [Connect QQ](../qq/); WeCom is postponed with no date set. Each channel accepts exactly one owner account.

## Steps

1. **Log in.** Settings → Channels: add a WeChat channel, enable it, click "Log in with QR code", scan with the WeChat account the assistant should use and confirm on the phone.
2. **Pair.** Click "Create pairing code" and, from **your own** WeChat, send 「绑定 123456」 (use the code shown on the page) to the assistant account in a direct chat. After that only your direct messages reach the conversation; messages from anyone else and group messages are ignored: no reply, and nothing is sent to the model.
3. **Approve actions from WeChat.** Actions that need approval are sent to WeChat; reply 「确认 K7」 or 「拒绝 K7」 (use the code in the message) to approve or deny.
4. **Login expired.** When the channel shows "Needs QR login", scan again.

## Commands in WeChat

| Send                 | Effect                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/clear` or 「清空」 | Clears only this channel's current conversation; memories are not deleted                                                                                                  |
| `/map`               | Browse the knowledge map: reply a number to drill down, `0` to go back, 「下一页」 for the next page; only titles and summaries are shown, open the Web UI for the content |

In the Web session list you can delete one conversation, or clear all of them (memories are kept there too).

## Where the login token is stored

The login token is stored in `secrets.yaml` in the data directory (key `ILINK_TOKEN_<channel id>`). Before writing, the server copies the file to `backups/secrets-<UTC time>.yaml` (`.yaml.enc` when the secrets file is encrypted, backed up as ciphertext; mode 600, newest 5 kept) and changes only that line; it doesn't write if `secrets.yaml` doesn't parse. On Windows it then removes inherited access entries so only the current user has full control. Deleting the channel removes only that line.

## Current limits

Images, files and logins that ask for a PIN are not supported yet.
