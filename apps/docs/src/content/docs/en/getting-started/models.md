---
title: Configure a model
description: Add a model profile for an OpenAI-compatible endpoint, a common provider or a local Ollama, and learn how keys are stored.
---

FatCat-AI ships no model of its own. You need at least one **model profile**: add it under Settings → Model profiles, or with `fatcat-ai models add`.

## What a profile contains

| Field         | Meaning                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Label         | Any name; shown in the UI                                                                                                                      |
| Kind          | `openai-compatible` (default), `anthropic`, `gemini`                                                                                           |
| Base URL      | For OpenAI-compatible endpoints, up to the `/v1` level; not needed for Anthropic and Gemini                                                    |
| Model         | The provider's model name                                                                                                                      |
| Key reference | `env:NAME` or `file:NAME`; leave empty for a local model                                                                                       |
| Purpose       | `chat`, `cheap` (summaries, memory extraction and other inexpensive work), `embed` (vector search), `stt` (speech to text), `tts` (read aloud) |

## How keys are stored

Neither the UI nor the API accepts a plaintext key, only a reference:

- `env:DEEPSEEK_API_KEY` reads an environment variable of the server process.
- `file:DEEPSEEK_API_KEY` reads the key of the same name in `secrets.yaml` in the data directory (one `NAME: value` per line); changes apply without a restart. You can encrypt this file under Settings → Secrets.

The profile list shows "Key: Set / Missing"; "Set" means the server found the key.

## Example providers

Take the base URL and model name from your provider's documentation; the table only shows the shape.

| Provider                     | Base URL                                            | Key reference example     |
| ---------------------------- | --------------------------------------------------- | ------------------------- |
| DeepSeek                     | `https://api.deepseek.com/v1`                       | `env:DEEPSEEK_API_KEY`    |
| SiliconFlow                  | `https://api.siliconflow.cn/v1`                     | `env:SILICONFLOW_API_KEY` |
| Alibaba Cloud Bailian (Qwen) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `env:DASHSCOPE_API_KEY`   |
| Zhipu                        | `https://open.bigmodel.cn/api/paas/v4`              | `env:ZHIPU_API_KEY`       |
| Moonshot                     | `https://api.moonshot.cn/v1`                        | `env:MOONSHOT_API_KEY`    |
| OpenRouter                   | `https://openrouter.ai/api/v1`                      | `env:OPENROUTER_API_KEY`  |
| Local Ollama                 | `http://127.0.0.1:11434/v1`                         | empty                     |

DeepSeek and OpenRouter have been used in practice; for voice, SiliconFlow's `Qwen/Qwen3-ASR-1.7B` (transcription) and `FunAudioLLM/CosyVoice2-0.5B` (read aloud). Voice profiles must be OpenAI-compatible with the `stt` or `tts` purpose.

Once an `stt` profile is set up, the main screen starts in **voice mode**: a single large Talk button in the middle (tap to start and tap again to stop, or hold to talk), with the reply shown as captions. To type, click Type or press `Ctrl/Cmd+I`; the text box opens in a popup and closes after sending. Press `Esc` while recording to cancel that recording. To turn voice mode off, set Default input to Text under Settings → Models → Voice. Without an `stt` profile, or when the browser cannot use the microphone, the main screen uses text input automatically. (Translated from the Chinese page; pending review.)

Turn on Continuous conversation under Settings → Models → Voice and the Talk button becomes Start / End conversation: the microphone stays on, each part is sent when you pause for about 0.8 s, replies are read aloud (this needs a `tts` profile), and you can interrupt the reading by speaking. Pauses are detected in the browser only; audio levels are never uploaded. The conversation ends after 8 s without speech by default (3–60 s; reading and waiting for a reply do not count), when the page goes to the background, when the network drops, or with `Esc`. While it is on, the top of the chat and the window title show Microphone on. (Translated from the Chinese page; pending review.)

## Command line

```bash
fatcat-ai models add --label deepseek --base-url https://api.deepseek.com/v1 \
  --model deepseek-flash --key-ref env:DEEPSEEK_API_KEY
```

For Anthropic or Gemini use `--kind anthropic` or `--kind gemini`; no `--base-url` is needed.

## Outbound connections

The base URLs you configure appear under Settings → Egress targets. FatCat-AI connects nowhere outside that list (apart from network tools you approve one call at a time in a conversation).
