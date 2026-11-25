---
title: Family accounts
description: Admins add members with invite codes, reset passwords, and disable or delete accounts.
---

> This page was translated from Chinese and is waiting for review.

From FatCat-AI 2.0, one server can have several accounts. The first account is an **admin**; later accounts are invited by an admin and are **members** by default. Each account has its own sessions, memories, mail, tasks, channels and devices, which nobody else can see. Admins manage the accounts themselves and cannot see a member's data either.

> Multi-user support is still being built (ADR 0053, 6 PRs). Members' own model keys, shared model profiles and opening plugins to members come in later PRs.

## Add a member

1. As an admin, open **Settings → System → Account & devices** and choose **Create invite code** in the Accounts section.
2. The code is shown only this once. It works once, within 24 hours. Give it to the person directly.
3. They open the sign-in page, choose **I have an invite code**, enter the code and pick their own username and password. They are signed in right away.

If the username is taken, the code stays valid and they can try another name. At most 10 unused codes can exist at a time. When the admin who created a code is disabled or made a member, that code stops working.

## Forgotten password

The admin chooses **Create reset code** on that account and gives the code to the person, who chooses **I have a reset code** on the sign-in page and enters it with a new password. After the reset, every sign-in, personal access token and paired device of that account stops working, so they sign in again. Admins cannot create a reset code for themselves; another admin has to.

If the only admin forgets their password, change it on the server machine:

- From source: in the repository's `apps/server` directory (run `pnpm build` first), run `node dist/index.js auth reset-password <username>` and type the new password twice (it is not shown).
- Docker: in the repository's `docker/` directory, run `printf '%s\n' 'new password' | docker compose -f docker-compose.prod.yml exec -T fatcat-ai node dist/index.js auth reset-password <username>`. The password is read from standard input, not from the command arguments; with `printf` it stays in your shell history, so clear it afterwards if that matters.

The new password needs at least 12 characters. Afterwards every sign-in, token and device of that account stops working, two-step verification is kept, and an audit entry is written. The server can be running or stopped.

## Roles, disabling and deleting

- **Make admin / Make member**: admins can change other accounts' roles, not their own. At least one active admin must remain.
- **Disable**: the account is signed out everywhere at once (browsers, tokens, devices, and open connections are closed), and its scheduled tasks, channels, mail sync and MCP servers stop. Signing in to a disabled account gets the same answer as a wrong password. **Enable** restarts the background work, but the person has to sign in again.
- **Delete**: type the account's username to confirm. The database is first backed up to `backups/` in the data folder (a file like `db-…-pre-delete-account.sqlite`), then all of the account's data is deleted, along with its lines in `secrets.yaml` (other lines stay). You cannot delete your own account.

Account management only works from a signed-in browser: personal access tokens and phone device tokens are refused, and an admin with two-step verification must have passed it.

## Capabilities only admins can turn on

The server runs as one system user, and the capabilities below let the assistant act on that machine, so only admins can configure them:

- **Authorized folders**: only admins add and revoke them. In Accounts, click **Assign folders** on a member's row to give that member a folder. Under Settings → Workbench → Folders a member sees only the folders assigned to them and can choose whether each goes into the knowledge base, but cannot add or revoke folders; writes still ask for approval every time. The same folder can be assigned to several people.
- **MCP servers**: only admins add and enable them; a member's settings page shows a short note instead.
- **Plugins**: only admins install, upgrade, roll back, enable and change settings. Opening plugins to members comes in a later PR.
- **Coding projects** (`git.*`, `code.run`): only admins configure and use them.
- **Embedding model**: one per server (changing it means rebuilding every vector), so only admins create embed profiles and rebuild the index; members' knowledge bases use it too.
- **Secrets file**: only admins see its status and run the encryption migration.

When an admin is changed to a member, the MCP servers, plugins and coding tools they set up stop working at once (the configuration is kept) and come back if they are made an admin again.

## Sign-in limits

Five wrong passwords in a row from the same address, or for the same username from anywhere, lock sign-in for a while. Invite and reset codes have the same kind of limit.
