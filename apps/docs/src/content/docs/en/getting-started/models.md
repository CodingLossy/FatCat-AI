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

Once an `stt` profile is set up, the main screen starts in **voice mode**: only a sphere in the middle, with the state, the model name and the current sentence of the reply below it, and no buttons. Tap the sphere to start talking and tap again to stop, or hold it to talk; while a reply is running, tap it (or press `Esc`) to stop. To type, press `Ctrl/Cmd+I`; the text box opens in a popup and closes after sending. Press `Ctrl/Cmd+H` for the whole conversation, and `Esc` while recording to cancel that recording. The small round logo at the top left opens the menu (sessions, panels, settings); switch models and agents from the command palette (`Ctrl/Cmd+K`). To turn voice mode off, set Default input to Text under Settings → Models → Voice. Without an `stt` profile, or when the browser cannot use the microphone, the main screen uses text input automatically. (Translated from the Chinese page; pending review.)

Continuous conversation (Settings → Models → Voice) is on by default: as soon as the main screen opens in voice mode, the microphone starts listening without a tap. Each part is sent when you pause for about 0.8 s, replies are read aloud (this needs a `tts` profile), and you can interrupt the reading by speaking. The first time, tap the sphere once so the browser can ask for microphone access; tap it once as well if the browser blocks sound from starting on its own. Tap the sphere to pause listening and tap again to resume. Pauses are detected in the browser only; audio levels are never uploaded. Listening pauses after 8 s without speech by default (3–60 s; reading and waiting for a reply do not count), when the network drops, or with `Esc`, and then waits for a tap. When the page goes to the background it also pauses and turns the microphone off, and it resumes on its own when you come back. While listening, the top of the screen and the window title show Microphone on. On a phone, long-press the sphere to type and swipe up on the main screen to see the whole conversation; when the assistant opens a panel (files, code and so on) it rises from the bottom and the sphere moves to the top, and while an approval is waiting the panel sits lower so it does not cover the approval card. With Continuous conversation off, tap the sphere to say one thing. (Translated from the Chinese page; pending review.)

## Command line

```bash
fatcat-ai models add --label deepseek --base-url https://api.deepseek.com/v1 \
  --model deepseek-flash --key-ref env:DEEPSEEK_API_KEY
```

For Anthropic or Gemini use `--kind anthropic` or `--kind gemini`; no `--base-url` is needed.

## Outbound connections

The base URLs you configure appear under Settings → Egress targets. FatCat-AI connects nowhere outside that list (apart from network tools you approve one call at a time in a conversation).
