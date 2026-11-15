# AGY Chrome Bridge

Use a Chrome tab from Antigravity CLI and Antigravity IDE through an MCP server. The Chrome extension talks to a Windows native messaging host; the host also provides the MCP stdio server. The existing `agy.exe` is never replaced.

## Requirements

- Windows, Google Chrome, and Antigravity CLI on `PATH`.
- Rust for building from source. The release archive already contains the executable.
- Load the extension in the Chrome profile you intend to use. Only one profile can connect to the bridge at a time.

## Installation

From a release archive, run `powershell -ExecutionPolicy Bypass -File .\install.ps1`. From source, run `cargo build --release --locked` then `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1`.

The installer copies the bridge and extension to `%LOCALAPPDATA%\agy-chrome-bridge`, registers Chrome native messaging for the current Windows user, and adds `agy-chrome-bridge` to AGY's global MCP configuration. It preserves existing unrelated MCP servers and backs up replaced bridge files and the MCP configuration. It refuses to overwrite a different existing host or MCP server using the same names. Exit existing AGY sessions and restart the CLI or IDE to reload MCP configuration.

In the intended Chrome profile, open `chrome://extensions`, turn on Developer mode, select **Load unpacked**, and choose `%LOCALAPPDATA%\agy-chrome-bridge\extension`. Open the extension on an HTTP(S) tab and select **Share this tab**. A shared tab can then be listed and controlled by AGY. Select **Stop sharing this tab** to revoke it; all shares expire when Chrome closes. Chrome may display a debugging banner while an operation is in progress.

Tell AGY to use `browser_tabs`, `browser_snapshot`, `browser_navigate`, `browser_click`, `browser_type`, or `browser_screenshot`. The snapshot provides visible text and CSS selectors for interactive elements. Navigation waits for the page load event; a dynamic page may require additional time. Screenshots cover the viewport and can fail if they exceed the native-message size limit. Chrome internal pages and `file:` URLs are intentionally unavailable.

## Security and privacy

Sharing grants AGY the ability to read the tab and interact with it, including entering text and clicking buttons. Share only tabs intended for that session, and review consequential actions. Site content is untrusted and must not override the user's instructions. The extension requests Chrome's `debugger`, `tabs`, `storage`, and `nativeMessaging` permissions. No remote debugging port is enabled.

The bridge listens on a random loopback port while the extension is connected. A random per-launch token and endpoint are stored in a Windows ACL-restricted local state directory; local processes running as the same Windows user can access them and should be trusted. The native host registration accepts only this extension ID. A file lock prevents a second profile from silently taking over the bridge.

## Recovery

Remove the extension through Chrome's extension manager. Remove the MCP entry with `agy mcp remove agy-chrome-bridge`, remove the `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.agy_chrome_bridge` registry key, and remove the bridge's own installation directory if no longer needed. Backups named `*.backup_*` and `mcp_config.json.backup_agy_chrome_*` can be used to recover prior files; restoring the whole MCP configuration also restores its other entries to that earlier point in time.

## Development

Run `cargo fmt --check`, `cargo build --locked`, `python tests/bridge_test.py target/debug/agy-chrome-bridge.exe`, and `node tests/extension_test.cjs` on Windows. The automated tests exercise MCP framing, token rejection, profile locking, ACL inheritance, and extension behavior with a simulated browser. They do not replace an end-to-end test in a real Chrome profile.
