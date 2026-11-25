---
title: Tool groups
description: How the assistant turns on file, mail, browser and other tools when it needs them, and the step and token limits for each answer.
---

> This English page is pending proofreading.

With many tools installed, sending every tool description to the model on every step uses up context and makes wrong tool choices more likely. So in a normal conversation the assistant starts with a small set of everyday tools; the rest are kept in groups and turned on when needed (design in ADR 0047).

## Always available

Memory (`memory.*`), arithmetic (`calc`), time (`time`), items and the knowledge base (`items.*`, `kb.search`), the UI panel (`ui.panel`), delegation (`delegate`, only for agents that are allowed to delegate), and `tools.enable`, which turns groups on.

## Groups turned on when needed

| Group          | Contents                                                          |
| -------------- | ----------------------------------------------------------------- |
| `fs`           | Files in the folders you authorized                               |
| `mail`         | E-mail                                                            |
| `web`          | Fetch a web page (`web.fetch`)                                    |
| `browser`      | Browser tools (only after you turn them on in Settings)           |
| `channel`      | Push a message to a chat channel                                  |
| `system`       | Open files and links with the default program (Settings)          |
| `code`         | Git history and registered commands of coding projects (Settings) |
| `mcp.<server>` | All tools of one MCP server                                       |
| `plugin.<id>`  | All tools of one plugin                                           |

The end of the system prompt lists these groups. To read a file, the assistant first calls `tools.enable` with `{ "group": "fs" }` and then `fs.read`.

- A group stays on for the current answer only: the next message starts from the everyday tools again, and nothing is stored.
- **Turning on a group never changes approvals.** Writing a file, sending mail or visiting a new site asks for approval exactly as before, and pre-authorizations and the rule that conditional pre-authorizations stop applying after the conversation has read outside content are unchanged.
- Calling a tool from a group that is not on returns `unknown tool: fs.read (enable group fs with tools.enable first)`; the call is audited as an unknown tool and not run.

## Coding projects (the `code` group)

This group exists only after you turn it on and register projects under Settings → Tools → Code. A project must be inside a folder authorized under Files and must be a git repository; if that folder is removed, the project cannot be used either.

- `git.log`, `git.show` and `git.diff` are read only: recent commits, "the 3rd most recent change" (`nth: 3`) and uncommitted changes in the working tree, with no approval. Git runs hardened, so the repository's own configuration (hooks, filters, external diff and so on) never runs a command.
- `code.run` only runs the commands you registered for the project (for example `test` → `pnpm test`), with at most 8 simple extra values (a test file, a filter). **You approve every run; it cannot be pre-authorized.** No shell is used, variables that look like secrets are removed from the environment, and cancelling or a timeout ends the whole process tree.
- A project is refused if its `.git` folder contains symbolic links or junctions (for example repositories managed by the `repo` tool), or if its repository data (git folder, alternates, `core.worktree`) points outside your authorized folders. Clone such a project normally (`git clone` without `--shared`) into an authorized folder to use it.
- Code changes still go through `fs.write`, approved each time. There are no tools that commit, push or switch branches.
- Commit messages, diffs and command output are treated as outside content: after reading them, conditional pre-authorizations stop applying.

(Translated from the Chinese page; pending review.)

## Scheduled tasks and agents

When a task or an agent has a tool set (`toolSet`), the tools it names are available right away without turning anything on, and groups outside the tool set cannot be turned on. Scheduled tasks without a tool set work like a normal conversation; tasks that send their result to a chat channel can use `channel.push` from the start.

## Step and token limits

- In a normal conversation or a scheduled task each answer can go back and forth with tools at most 10 times (previously 5); agents use their own "max steps" setting.
- Normal conversations and scheduled tasks also have a budget of 60,000 tokens per answer, summed over all steps. Once it is used up no further step starts and the answer ends with a note saying so; you can ask the assistant to continue. Agents keep their own token and time budgets.
