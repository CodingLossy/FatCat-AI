---
title: Family accounts
description: Admins add members with invite codes, reset passwords, and disable or delete accounts.
---

> This page was translated from Chinese and is waiting for review.

From FatCat-AI 2.0, one server can have several accounts. The first account is an **admin**; later accounts are invited by an admin and are **members** by default. Each account has its own sessions, memories, mail, tasks, channels and devices, which nobody else can see. Admins manage the accounts themselves and cannot see a member's data either.

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
- **Plugins**: only admins install, upgrade, roll back, enable and change settings. An admin can tick **Open to members** under a plugin's Manage: members then see it read-only on the plugins page (marked Opened by admin) and can use its tools in conversations, but cannot see its secret bindings or settings and cannot enable, stop or uninstall it. Unticking it, or the admin being demoted or disabled, stops members using it at once.
- **Coding projects** (`git.*`, `code.run`): only admins configure and use them.
- **Embedding model**: one per server (changing it means rebuilding every vector), so only admins create embed profiles and rebuild the index; members' knowledge bases use it too.
- **Secrets file**: only admins see its status and run the encryption migration; each account's own secrets are covered in the next section.

When an admin is changed to a member, the MCP servers, plugins and coding tools they set up stop working at once (the configuration is kept) and come back if they are made an admin again.

## Secrets and shared models

Every account can save its own API keys and mail app passwords under Settings → System → Secrets → **My secrets**: enter a name and the value. Once saved only the name and the reference to use (for example `file:OPENAI_API_KEY`) are shown, never the value. Put that `file:` reference in a model profile's key reference or a mail account's password.

- Secrets a member saves can only be used by that member's own profiles and mail accounts; other accounts, admins included, cannot see or refer to them. A member's reference contains an account number (`file:U…_OPENAI_API_KEY`); that is expected, use it as shown. Entering `file:OPENAI_API_KEY` without the number also works and is changed to the member's own key.
- `env:` references read the server's environment variables, so only admins can use them.
- After a secret is deleted, profiles and mail accounts that use it show it as missing. Deleting an account deletes its secrets too.

An admin can tick **Share with members** on a model profile so the whole family uses one model account. Members see it in their model list marked Shared by admin and can pick it for conversations, the default model and voice, but cannot see its address or key reference and cannot edit, delete or test it. When the admin stops sharing it, is changed to a member or is disabled, members can no longer use it.

## Concurrent conversations and disk use

The machine and the model quota are shared by the whole family, so each account can have at most 2 conversations running at once and the whole installation at most 6. Sending another message does not fail: it shows Queued: other conversations are still running… and starts by itself when one finishes, and you can stop it while it waits. A conversation waiting for your approval also takes a place. Admins can change both limits (1–1000) with the environment variables `FATCAT_AI_MAX_RUNS_PER_ACCOUNT` and `FATCAT_AI_MAX_RUNS` when starting the server.

Scheduled tasks, mail sync, memory extraction and knowledge-base embedding take turns between accounts in the background, so one account's large mailbox or batch of tasks does not keep everyone else waiting. The daily embedding limit counts separately for each account.

In the Accounts list each account shows its disk use, attachments and the knowledge-base index separately. 2.0 only shows it and sets no quota. Attachments are kept per account under `attachments/<account id>/` in the data directory; when upgrading from an older version the server moves the existing attachments there the first time it starts (it copies first and deletes the old files only once everything is copied; if it is interrupted it carries on at the next start).

## Family and small-team setup

- **One machine, one admin**: the admin looks after model accounts, the secrets file, plugins and backups; everyone else uses a member account. The admin can chat from their own account too, but a separate member account for everyday use avoids changing installation settings by mistake.
- **At least two admins**: make another trusted person an admin so that each can create a reset code for the other after a forgotten password or a lost authenticator. When only one admin is left, they cannot be demoted, disabled or deleted.
- **Access from outside**: when people use it from outside the home, put it behind HTTPS as in the [Docker deployment guide](/FatCat-AI/en/guides/docker/) and have everyone turn on two-step verification.
- **Model quota**: an admin can share one model profile with members so everyone uses it. Each account can run at most 2 conversations at once and the installation at most 6 (previous section); lower `FATCAT_AI_MAX_RUNS` when the quota is tight.
- **Backups**: back up the whole data directory (or Docker volume), including `attachments/`, and keep the master key separately. Admins cannot see members' data, but the backup holds everyone's data, so keep it as carefully as the master key.

## Upgrading to 2.0 and going back

- **Before upgrading, stop the server and back up the whole data directory** (for Docker see section 8 of the deployment guide), not only `db.sqlite`. The first start after upgrading runs database migrations 0022–0025 (backed up first to `backups/db-…-pre-0022.sqlite` and so on; that automatic backup is only the database file) and moves attachments into `attachments/<account id>/` (it copies first, deletes the old files only once everything is copied, and carries on at the next start if interrupted). The existing account becomes an admin and its data is unchanged.
- **Going back to 1.x**: older versions cannot open the migrated database, and images are no longer flat files directly under `attachments/`, which is the only place 1.x looks. Stop the server, replace the data directory with the whole directory you backed up before the upgrade (including `db.sqlite`, `attachments/` and the rest), then start the old version. Copying only `backups/db-…-pre-….sqlite` back over `db.sqlite` lets 1.x start, but the pictures stay in the per-account folders, so the old version does not show them. Anything created after the upgrade (new conversations, member accounts) is lost.
- **Lost authenticator and recovery codes**: on the server machine run `auth reset-totp <username>` to reset only that account (the username can be left out when there is only one account). When an admin forgets their password and there is no other admin, run `auth reset-password <username>`. Stop the server first for both; see the [FAQ](/FatCat-AI/en/faq/).

## Sign-in limits

Five wrong passwords in a row from the same address, or for the same username from anywhere, lock sign-in for a while. Invite and reset codes have the same kind of limit.
