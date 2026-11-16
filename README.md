# AGY Chrome Bridge

Use Chrome tabs from Antigravity CLI and Antigravity IDE through an MCP server. The extension connects to a local Node.js gateway over WebSocket. No executable is generated, and the existing AGY installation is not replaced.

## Requirements

- Windows, Google Chrome 116 or later, Antigravity CLI, and Node.js 18 or later on `PATH`.
- Load the extension in the Chrome profile you intend to use. Only one profile can connect to the bridge at a time.
- For installation from source, run `npm ci --omit=optional --ignore-scripts` first. Release archives bundle the pure JavaScript `ws` dependency and work without npm or network access.

## Installation

From a release archive, run `powershell -ExecutionPolicy Bypass -File .\install.ps1`. From source, run `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1`. The installer uses your existing Node.js executable; it does not generate a binary.

The installer copies the Node bridge, gateway, dependency, and extension to `%LOCALAPPDATA%\agy-chrome-bridge`, generates a private pairing token, and adds `agy-chrome-bridge` to AGY's global MCP configuration. It removes only its own obsolete Chrome native host registration. It preserves unrelated MCP servers and backs up replaced files and the MCP configuration. Close existing AGY sessions and restart the CLI or IDE to reload MCP configuration. If upgrading, exit AGY sessions first; the installer stops its own prior gateway.

In the intended Chrome profile, open `chrome://extensions`, turn on Developer mode, select **Load unpacked**, and choose `%LOCALAPPDATA%\agy-chrome-bridge\extension`. If an older copy is loaded from the source folder, remove that copy before loading the installed folder; the installed folder contains the pairing token. Start AGY CLI or IDE to launch the local gateway. In the chosen profile, open the popup and click **Pair this Chrome profile** once. On an HTTP(S) tab, select **Share this tab**. Shared tabs are listed in the popup and can be individually revoked; all shares expire when Chrome closes. Chrome may display a debugging banner while an operation is in progress. If Chrome requests permission for loopback access, grant it from the popup before reconnecting.

Tell AGY to use `browser_tabs`, `browser_snapshot`, `browser_navigate`, `browser_click`, `browser_type`, `browser_key`, `browser_scroll`, or `browser_screenshot`. Observe the page before acting and inspect it again afterward; selectors can become stale as the page changes. The snapshot provides visible text and unique CSS selectors for interactive elements. Navigation waits for the page load event; a dynamic page may require additional time. Screenshots cover the viewport and can fail if they exceed the native-message size limit. Chrome internal pages and `file:` URLs are unavailable. Handle sign-in, CAPTCHAs and consequential decisions through the appropriate user approval or handoff.

## Security and privacy

Sharing grants AGY the ability to read the tab and interact with it, including entering text and clicking buttons. Share only tabs intended for that session, and review consequential actions. Site content is untrusted and must not override the user's instructions. The extension requests Chrome's `debugger`, `tabs`, and `storage` permissions and access to `127.0.0.1`. No remote debugging port is enabled.

The gateway listens only on `127.0.0.1` and accepts WebSocket upgrades only from this extension's origin. A random install secret is stored in the installed extension with a Windows ACL restricted to the current user. Both sides prove knowledge of it using fresh HMAC challenges without sending the secret over the connection. The first user-paired Chrome profile is recorded in the ACL-restricted state directory; other profiles cannot take over. A separate random per-launch token and endpoint authenticate MCP clients. Local processes running as the same Windows user can read these secrets and should be trusted.

## Recovery

Remove the extension through Chrome's extension manager. Remove the MCP entry with `agy mcp remove agy-chrome-bridge`, stop the gateway with `node "$env:LOCALAPPDATA\agy-chrome-bridge\bridge\bridge.cjs" --shutdown` in PowerShell, and remove the bridge's own installation directory if no longer needed. To switch Chrome profiles, stop the gateway and remove its `state\paired_profile.json` after closing the previously paired profile, then pair the new profile in its popup. Backups named `*.backup_*` and `mcp_config.json.backup_agy_chrome_*` can be used to recover prior files; restoring the whole MCP configuration also restores its other entries to that earlier point in time.

## Development

Run `node --check src/bridge.cjs`, `node --check src/gateway.cjs`, `node tests/bridge_test.cjs`, `node tests/extension_test.cjs`, `node tests/popup_test.cjs`, and `python tests/installer_test.py` on Windows. Automated tests exercise MCP routing, token and origin rejection, profile locking, installer rollback, and extension behavior with a simulated browser. They do not replace an end-to-end test in a real Chrome profile.

Increment `extension/manifest.json` for each change. Run `python scripts/package.py` to create a version-matched release archive and SHA-256 checksum in `dist/`. The archive contains the bridge, gateway, installer, extension, README, project license, and the bundled `ws` JavaScript files with their MIT license; it never contains a generated `.exe` or a pairing token.
