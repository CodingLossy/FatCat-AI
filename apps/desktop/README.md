# apps/desktop

Tauri v2 desktop shell. The core server runs as a sidecar on a random loopback port; the window loads it, closing the window keeps the app in the tray, and the sidecar exits when the shell does. No paid macOS/Windows code signing for now. (ADR 0044)

Tauri v2 桌面壳:核心作为 sidecar 在随机回环端口运行,窗口加载它;关窗驻留托盘,壳退出(含崩溃)时 sidecar 随之退出。暂不做付费代码签名。

## Develop

```sh
pnpm build
node apps/desktop/scripts/bundle-sidecar.mjs      # stage dist/sidecar
cd apps/desktop/src-tauri
FATCAT_AI_SIDECAR_DIR=../dist/sidecar cargo run  # needs node on PATH (or FATCAT_AI_NODE)
```

On Linux you need `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`. `pnpm --filter @fatcat-ai/desktop check:shell` (Linux, xvfb) verifies that the sidecar exits when the shell is killed.
