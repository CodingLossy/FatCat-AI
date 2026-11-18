# 桌面版安装指南

桌面版是一个小窗口加托盘图标,里面带着完整的 FatCat-AI 服务,数据全在本机。**安装包没有付费代码签名**(项目暂不购买),所以系统会提示「未知发布者」;下面写了每个系统怎么放行,以及怎么自己校验下载的文件没被改过。

> 这页的步骤在 Linux 上实际跑过(安装包解包后运行,带自带的 Node,数据写入自己的目录)。Windows 和 macOS 的步骤**还没有在真机上验证**,以业主实测后的版本为准。

## 1. 下载与校验

在 GitHub 的 Releases 页面下载你系统的安装包,同时下载 `SHA256SUMS` 和 `SHA256SUMS.cosign.bundle`。

1. 校验和:`sha256sum -c SHA256SUMS --ignore-missing`(macOS 用 `shasum -a 256 -c SHA256SUMS --ignore-missing`;Windows PowerShell 用 `Get-FileHash <文件> -Algorithm SHA256` 与 `SHA256SUMS` 里的值对比)。
2. 签名(可选,需要安装 [cosign](https://github.com/sigstore/cosign)):

```sh
cosign verify-blob --bundle SHA256SUMS.cosign.bundle \
  --certificate-identity-regexp '^https://github.com/CodingLossy/FatCat-AI/\.github/workflows/desktop-release\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
```

签名证明校验和文件确实由本仓库的发布工作流生成。

## 2. 安装

- **Windows**(`.msi` 或 `.exe`):双击运行。出现 SmartScreen 蓝色提示时点「更多信息」→「仍要运行」。
- **macOS**(`.dmg`):把应用拖进「应用程序」。第一次打开请**右键 → 打开**;如果仍被拦截,在终端执行 `xattr -dr com.apple.quarantine /Applications/FatCat-AI.app` 后再打开。
- **Linux**:`.deb` 用 `sudo apt install ./FatCat-AI_*.deb`;`.rpm` 用 `sudo rpm -i`;`.AppImage` 先 `chmod +x` 再运行。

## 3. 使用

- 第一次打开会像网页版一样让你创建账户(本机窗口不需要设置码)。
- 关闭窗口只是收到托盘,程序继续运行;托盘菜单可以「显示」「开机自启」「退出」。「退出」会让内置服务一起正常关闭。
- 全局快捷键 `Ctrl+Shift+Space` 唤起窗口并聚焦输入框(被别的程序占用时不生效)。
- 链接 `fatcat-ai://chat/<会话 id>` 打开会话,`fatcat-ai://ask?text=...` 只把文字填进输入框,**不会自动发送**;其他链接一律忽略。
- 知识地图有「粒子球」视图;记忆页有「记忆地图」。

## 4. 数据在哪里

桌面版用自己的数据目录,与命令行 / Docker 版的 `~/.fatcat-ai` **分开**:

| 系统    | 位置                                              |
| ------- | ------------------------------------------------- |
| Windows | `%APPDATA%\ai.fatcat.desktop`                     |
| macOS   | `~/Library/Application Support/ai.fatcat.desktop` |
| Linux   | `~/.local/share/ai.fatcat.desktop`                |

卸载程序不会删除这个目录。要「导入已有数据」目前需要手动备份后复制,界面里的导入功能还没有做。

## 5. 目前没有的

自动更新(需要先生成更新签名密钥)、系统通知、文件拖拽、连接远程服务器的模式、API Key 存系统钥匙串。
