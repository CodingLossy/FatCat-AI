---
title: 配置模型
description: 添加模型配置档:OpenAI 兼容端点、国内常见服务、本地 Ollama,以及密钥怎么存。
---

FatCat-AI 自己不带模型,你需要至少一个**模型配置档**。在「设置 → 模型配置档」添加,或用命令行 `fatcat-ai models add`。

## 一个配置档包含什么

| 字段     | 说明                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------- |
| 名称     | 随便起,界面里显示                                                                                  |
| 类型     | `openai-compatible`(默认)、`anthropic`、`gemini`                                                   |
| 接口地址 | OpenAI 兼容端点填到 `/v1` 这一级;Anthropic 和 Gemini 不用填                                        |
| 模型     | 服务商的模型名                                                                                     |
| 密钥引用 | `env:变量名` 或 `file:键名`;本地模型可以留空                                                       |
| 用途     | `chat`(对话)、`cheap`(摘要、记忆抽取等便宜任务)、`embed`(向量检索)、`stt`(语音转文字)、`tts`(朗读) |

## 密钥怎么存

页面和 API **都不接收明文密钥**,只接收引用:

- `env:DEEPSEEK_API_KEY`:读服务器进程的环境变量。
- `file:DEEPSEEK_API_KEY`:读数据目录里 `secrets.yaml` 的同名键(每行 `NAME: value`),修改后不用重启。可以在「设置 → 密钥」里加密这个文件。

配置档列表会显示「密钥: 已设置 / 缺失」,看到「已设置」说明服务器找到了密钥。

## 常见服务示例

接口地址和模型名以服务商文档为准,下面只是写法示例。

| 服务             | 接口地址                                            | 密钥引用示例              |
| ---------------- | --------------------------------------------------- | ------------------------- |
| DeepSeek         | `https://api.deepseek.com/v1`                       | `env:DEEPSEEK_API_KEY`    |
| 硅基流动         | `https://api.siliconflow.cn/v1`                     | `env:SILICONFLOW_API_KEY` |
| 阿里云百炼(通义) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `env:DASHSCOPE_API_KEY`   |
| 智谱             | `https://open.bigmodel.cn/api/paas/v4`              | `env:ZHIPU_API_KEY`       |
| 月之暗面         | `https://api.moonshot.cn/v1`                        | `env:MOONSHOT_API_KEY`    |
| OpenRouter       | `https://openrouter.ai/api/v1`                      | `env:OPENROUTER_API_KEY`  |
| 本地 Ollama      | `http://127.0.0.1:11434/v1`                         | 留空                      |

已经实际用过的有 DeepSeek、OpenRouter,语音用过硅基流动的 `Qwen/Qwen3-ASR-1.7B`(转写)和 `FunAudioLLM/CosyVoice2-0.5B`(朗读)。语音配置档必须是 OpenAI 兼容类型,用途选 `stt` 或 `tts`。

## 命令行写法

```bash
fatcat-ai models add --label deepseek --base-url https://api.deepseek.com/v1 \
  --model deepseek-flash --key-ref env:DEEPSEEK_API_KEY
```

Anthropic 或 Gemini 用 `--kind anthropic` 或 `--kind gemini`,不需要 `--base-url`。

## 出站连接

你配置的接口地址会出现在「设置 → 出站目标」里。FatCat-AI 不会连接这个列表以外的地址(你在对话里批准的网络工具除外)。
