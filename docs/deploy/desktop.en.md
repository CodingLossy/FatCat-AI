# Desktop installation guide

> Machine-translated from [desktop.md](desktop.md); **pending proofreading**.

The desktop app is a small window plus a tray icon with the full FatCat-AI server inside; all data stays on your machine. **The installers are not code-signed with a paid certificate** (the project does not buy one), so your system will warn about an "unknown publisher". Below is how to allow it on each system and how to check that the file you downloaded was not altered.

> These steps were run on Linux and Windows 11 (bundled Node, own data directory; install, start, quit and deep links were checked on Windows). macOS has **not been verified on a real machine yet**, and the tray, start-at-login and global shortcut still wait for the owner's manual check on Windows.

## 1. Download and verify

Download the installer for your system from the GitHub Releases page, plus `SHA256SUMS` and `SHA256SUMS.cosign.bundle`.

1. Checksums: `sha256sum -c SHA256SUMS --ignore-missing` (on macOS `shasum -a 256 -c SHA256SUMS --ignore-missing`; in Windows PowerShell compare `Get-FileHash <file> -Algorithm SHA256` with the value in `SHA256SUMS`).
2. Signature (optional, needs [cosign](https://github.com/sigstore/cosign)):

```sh
cosign verify-blob --bundle SHA256SUMS.cosign.bundle \
  --certificate-identity-regexp '^https://github.com/CodingLossy/FatCat-AI/\.github/workflows/desktop-release\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
```

The signature proves that the checksum file was produced by this repository's release workflow.

## 2. Install

- **Windows** (`.msi` or `.exe`): double-click. If SmartScreen shows the blue warning, click "More info" then "Run anyway".
- **macOS** (`.dmg`): drag the app into Applications. Open it the first time with **right-click → Open**; if it is still blocked, run `xattr -dr com.apple.quarantine /Applications/FatCat-AI.app` in a terminal and open it again.
- **Linux**: for `.deb` use `sudo apt install ./FatCat-AI_*.deb`; for `.rpm` use `sudo rpm -i`; for `.AppImage` run `chmod +x` first.

## 3. Using it

- On first start you create an account, as in the web version (the local window does not ask for a setup code).
- Closing the window only hides it to the tray and the app keeps running; the tray menu has Show, Start at login and Quit. Quit also shuts the built-in server down cleanly.
- The global shortcut `Ctrl+Shift+Space` brings the window forward and focuses the message box (it does nothing if another program owns that shortcut).
- The link `fatcat-ai://chat/<session id>` opens a conversation, and `fatcat-ai://ask?text=...` only fills the text into the message box and **never sends it**; every other link is ignored.
- The knowledge map has a "Sphere" view and the Memory page has a "Memory map".

## 4. Where the data is

The desktop app has its own data directory, **separate** from the `~/.fatcat-ai` used by the command line and Docker:

| System  | Location                                          |
| ------- | ------------------------------------------------- |
| Windows | `%APPDATA%\ai.fatcat.desktop`                     |
| macOS   | `~/Library/Application Support/ai.fatcat.desktop` |
| Linux   | `~/.local/share/ai.fatcat.desktop`                |

On Windows the web view (WebView2) keeps its cache in `%LOCALAPPDATA%\ai.fatcat.desktop`. Uninstalling does **not** delete either directory. The core service writes its output to `logs\sidecar.log` inside the data directory (overwritten at each start, local only); if it fails to start, the app shows an error box with this path. To bring existing data in, back it up and copy it by hand for now; an import feature in the UI is not built yet.

## 5. Not available yet

Automatic updates (they need an update-signing key first), system notifications, file drop, the connect-to-a-remote-server mode, and storing API keys in the system keychain.
