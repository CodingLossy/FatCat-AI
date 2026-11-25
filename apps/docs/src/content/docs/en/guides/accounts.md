---
title: Family accounts
description: Admins add members with invite codes, reset passwords, and disable or delete accounts.
---

> This page was translated from Chinese and is waiting for review.

From FatCat-AI 2.0, one server can have several accounts. The first account is an **admin**; later accounts are invited by an admin and are **members** by default. Each account has its own sessions, memories, mail, tasks, channels and devices, which nobody else can see. Admins manage the accounts themselves and cannot see a member's data either.

> Multi-user support is still being built (ADR 0053, 6 PRs). This page covers account management; members' own model keys and the admin-only settings for plugins and MCP come in later PRs.

## Add a member

1. As an admin, open **Settings → System → Account & devices** and choose **Create invite code** in the Accounts section.
2. The code is shown only this once. It works once, within 24 hours. Give it to the person directly.
3. They open the sign-in page, choose **I have an invite code**, enter the code and pick their own username and password. They are signed in right away.

If the username is taken, the code stays valid and they can try another name. At most 10 unused codes can exist at a time. When the admin who created a code is disabled or made a member, that code stops working.

## Forgotten password

The admin chooses **Create reset code** on that account and gives the code to the person, who chooses **I have a reset code** on the sign-in page and enters it with a new password. After the reset, every sign-in, personal access token and paired device of that account stops working, so they sign in again. Admins cannot create a reset code for themselves; another admin has to, so having at least two admins is a good idea.

## Roles, disabling and deleting

- **Make admin / Make member**: admins can change other accounts' roles, not their own. At least one active admin must remain.
- **Disable**: the account is signed out everywhere at once (browsers, tokens, devices, and open connections are closed), and its scheduled tasks, channels, mail sync and MCP servers stop. Signing in to a disabled account gets the same answer as a wrong password. **Enable** restarts the background work, but the person has to sign in again.
- **Delete**: type the account's username to confirm. The database is first backed up to `backups/` in the data folder (a file like `db-…-pre-delete-account.sqlite`), then all of the account's data is deleted, along with its lines in `secrets.yaml` (other lines stay). You cannot delete your own account.

Account management only works from a signed-in browser: personal access tokens and phone device tokens are refused, and an admin with two-step verification must have passed it.

## Sign-in limits

Five wrong passwords in a row from the same address, or for the same username from anywhere, lock sign-in for a while. Invite and reset codes have the same kind of limit.
