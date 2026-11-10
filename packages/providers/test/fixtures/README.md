# Provider fixtures

Recorded HTTP interactions replayed by the provider tests.

- `deepseek-*.json`: recorded against the DeepSeek API (`https://api.deepseek.com/v1`, model `deepseek-chat`) on 2026-11-03 with `scripts/record-fixtures.mjs`. The auth-error fixture uses a deliberately invalid key.
- Files with `"synthetic": true` were written by hand from the OpenAI-compatible streaming format; they cover cases a single provider does not produce (Ollama-style CRLF and split events, no usage). The `anthropic-*` and `gemini-*` fixtures are synthetic as well, written from the documented Anthropic Messages and Gemini `streamGenerateContent` streaming formats.

To re-record against a real endpoint (keys are read from the environment and redacted before anything is written):

```bash
FATCAT_AI_EVAL_LIVE=1 FATCAT_AI_EVAL_BASE_URL=https://api.example.com/v1 FATCAT_AI_EVAL_MODEL=model-name FATCAT_AI_EVAL_KEY_ENV=MY_API_KEY \
  pnpm --filter @fatcat-ai/providers test
```

`pnpm check:secrets` fails if anything that looks like a credential appears in a fixture.
