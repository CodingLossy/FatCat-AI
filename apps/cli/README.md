# apps/cli

命令行客户端 `ai-personal`。只通过公开的 `/api/v1`(经 `@ai-personal/client`)与核心服务通信,设计见 [ADR 0008](../../docs/adr/0008-client-sdk-and-cli.md)。运行 `ai-personal --help` 查看全部命令。

Command-line client `ai-personal`. It talks to the core only through the public `/api/v1` API (via `@ai-personal/client`); see [ADR 0008](../../docs/adr/0008-client-sdk-and-cli.md). Run `ai-personal --help` for all commands.

```bash
ai-personal setup -u owner                 # first run: create the owner and save a token
ai-personal login -u owner                 # later: sign in again
ai-personal models add --label deepseek --base-url https://api.deepseek.com/v1 \
    --model deepseek-chat --key-ref env:DEEPSEEK_API_KEY
ai-personal ask "hello"                    # reply on stdout, status on stderr
echo "summarise this" | ai-personal ask --stdin --json
ai-personal chat                           # /new /model <id|label> /retry /exit
ai-personal sessions list
ai-personal sessions show <id>
ai-personal memory list                    # also: search <query>, add <text>, edit <id> <text>, forget <id>
```

- Configuration: `--server` > `AIP_SERVER` / `AIP_TOKEN` > `~/.ai-personal/cli.json` (`AIP_CLI_CONFIG` overrides the path). The token is never accepted as a command-line argument and never printed.
- Passwords are read silently in a terminal, or with `--password-stdin` in scripts.
- Tool approvals: asked in a terminal (default no), rejected when not interactive, approved only with `--approve-tools`.
- Exit codes: 0 ok, 1 error, 2 usage error, 130 cancelled.
