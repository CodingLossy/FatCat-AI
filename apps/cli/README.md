# apps/cli

命令行客户端 `fatcat-ai`。只通过公开的 `/api/v1`(经 `@fatcat-ai/client`)与核心服务通信,设计见 [ADR 0008](../../docs/adr/0008-client-sdk-and-cli.md)。运行 `fatcat-ai --help` 查看全部命令。

Command-line client `fatcat-ai`. It talks to the core only through the public `/api/v1` API (via `@fatcat-ai/client`); see [ADR 0008](../../docs/adr/0008-client-sdk-and-cli.md). Run `fatcat-ai --help` for all commands.

```bash
fatcat-ai setup -u owner                 # first run: create the owner and save a token
fatcat-ai login -u owner                 # later: sign in again
fatcat-ai models add --label deepseek --base-url https://api.deepseek.com/v1 \
    --model deepseek-chat --key-ref env:DEEPSEEK_API_KEY
fatcat-ai ask "hello"                    # reply on stdout, status on stderr
echo "summarise this" | fatcat-ai ask --stdin --json
fatcat-ai chat                           # /new /model <id|label> /retry /exit
fatcat-ai sessions list
fatcat-ai sessions show <id>
fatcat-ai memory list                    # also: search <query>, add <text>, edit <id> <text>, forget <id>
```

- Configuration: `--server` > `FATCAT_AI_SERVER` / `FATCAT_AI_TOKEN` > `~/.fatcat-ai/cli.json` (`FATCAT_AI_CLI_CONFIG` overrides the path). The token is never accepted as a command-line argument and never printed.
- Passwords are read silently in a terminal, or with `--password-stdin` in scripts.
- Tool approvals: asked in a terminal (default no), rejected when not interactive, approved only with `--approve-tools`.
- Exit codes: 0 ok, 1 error, 2 usage error, 130 cancelled.
