# AGY Chrome Bridge

Use Chrome tabs from Antigravity CLI and Antigravity IDE through an MCP server. The extension talks to a Node.js native messaging host. No executable is generated, and the existing AGY installation is not replaced.

## Requirements

- Windows, Google Chrome, Antigravity CLI, and Node.js 18 or later on `PATH`.
- Load the extension in the Chrome profile you intend to use. Only one profile can connect to the bridge at a time.

## Installation

From a release archive, run `powershell -ExecutionPolicy Bypass -File .\install.ps1`. From source, run `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1`. The installer uses your existing Node.js executable; it does not generate a binary.

The installer copies the script and extension to `%LOCALAPPDATA%\agy-chrome-bridge`, registers a `host.cmd` launcher for Chrome native messaging, and adds `agy-chrome-bridge` to AGY's global MCP configuration. It preserves unrelated MCP servers, backs up replaced files and the MCP configuration, and refuses to overwrite a different host or MCP server using the same names. Close existing AGY sessions and restart the CLI or IDE to reload MCP configuration. If upgrading, disconnect the extension and exit AGY sessions first.

In the intended Chrome profile, open `chrome://extensions`, turn on Developer mode, select **Load unpacked**, and choose `%LOCALAPPDATA%\agy-chrome-bridge\extension`. If Chrome reports that the host cannot be found after initial installation, save your work and fully restart Chrome. Open the extension on an HTTP(S) tab and select **Share this tab**. Shared tabs are listed in the popup and can be individually revoked; all shares expire when Chrome closes. Chrome may display a debugging banner while an operation is in progress.

Tell AGY to use `browser_tabs`, `browser_snapshot`, `browser_navigate`, `browser_click`, `browser_type`, `browser_key`, `browser_scroll`, or `browser_screenshot`. Observe the page before acting and inspect it again afterward; selectors can become stale as the page changes. The snapshot provides visible text and unique CSS selectors for interactive elements. Navigation waits for the page load event; a dynamic page may require additional time. Screenshots cover the viewport and can fail if they exceed the native-message size limit. Chrome internal pages and `file:` URLs are unavailable. Handle sign-in, CAPTCHAs and consequential decisions through the appropriate user approval or handoff.

## Security and privacy

Sharing grants AGY the ability to read the tab and interact with it, including entering text and clicking buttons. Share only tabs intended for that session, and review consequential actions. Site content is untrusted and must not override the user's instructions. The extension requests Chrome's `debugger`, `tabs`, `storage`, and `nativeMessaging` permissions. No remote debugging port is enabled.

The bridge listens on a random loopback port while the extension is connected. A random per-launch token and endpoint are stored in a Windows ACL-restricted local state directory; local processes running as the same Windows user can access them and should be trusted. The native host registration accepts only this extension ID. A per-user named-pipe lock prevents a second profile from silently taking over the bridge.

## Recovery

Remove the extension through Chrome's extension manager. Remove the MCP entry with `agy mcp remove agy-chrome-bridge`, remove the `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.agy_chrome_bridge` registry key, and remove the bridge's own installation directory if no longer needed. Backups named `*.backup_*` and `mcp_config.json.backup_agy_chrome_*` can be used to recover prior files; restoring the whole MCP configuration also restores its other entries to that earlier point in time.

## Development

Run `node --check src/bridge.cjs`, `python tests/bridge_test.py`, `node tests/extension_test.cjs`, `node tests/popup_test.cjs`, and `python tests/installer_test.py` on Windows. Automated tests exercise MCP framing, token rejection, profile locking, ACL inheritance, installer rollback, and extension behavior with a simulated browser. They do not replace an end-to-end test in a real Chrome profile.
