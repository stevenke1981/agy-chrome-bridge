# Review round 1 fix brief (v0.4.0)

Source: independent review of 5fdf644 (REQUEST CHANGES). Two implementers, file-disjoint.

## Shared contract (both sides must match exactly)
- Pairing mismatch: the gateway closes the extension socket with code **4001** and reason **`profile-mismatch`**.
  Other auth failures keep 1008. The extension shows, for 4001:
  `This Chrome profile is not the paired one. Run: node "%LOCALAPPDATA%\agy-chrome-bridge\bridge\bridge.cjs" --unpair`
- `bridge.cjs --unpair`: stops the gateway if running (same as --shutdown), then deletes `state/paired_profile.json`. Prints what it did. Exit 0 when nothing to do.
- Gateway: when a tool call arrives and no extension is connected, wait up to **10 s** for the extension to connect before failing with the existing "Chrome is not connected" message.
- Tool errors from the extension stay `{id, error: string}`; new error strings are free text.
- Version becomes **0.4.0** (extension/manifest.json; bridge reads it from there).

## Implementer A — extension (owns extension/background.js, extension/popup.js, extension/popup.html, extension/manifest.json, tests/extension_test.cjs, tests/popup_test.cjs)
1. HIGH: add `alarms` permission; `chrome.alarms.create('reconnect', {periodInMinutes: 0.5})` on install/startup and at worker top level; on alarm, call `connect()` when no open socket. Keep the 5 s setTimeout as a fast path.
2. Handle close code 4001 → status text from the contract.
3. Serialize all operations per tabId with a promise queue (concurrent calls on one tab must not hit "Another debugger is already attached").
4. Per-command timeout: wrap each `chrome.debugger.sendCommand` (and the whole op) in a timeout (15 s per command, 25 s per op, below the gateway's 30 s); always detach on timeout/failure.
5. Origin lock: when a tab is shared, record its origin (`chrome.storage.session` key `sharedOrigins: {[tabId]: origin}`; keep `sharedTabs` array as is). Every operation checks the tab's current URL origin equals the recorded origin; otherwise error `Tab moved to <origin>; share it again from the extension popup.` `browser_navigate` refuses a cross-origin URL with the same kind of message. Popup share/stop must write/remove the origin; re-sharing updates it. browser_tabs output adds `sharedOrigin`.
6. LOW: `scrollIntoView({block:'center', inline:'center', behavior:'instant'})` before the elementFromPoint check.
7. Bump manifest version to 0.4.0.
8. Tests: extend the simulated-browser tests for 1–5 (alarm reconnect, 4001 status, two concurrent snapshots on one tab both succeed, timeout detaches, cross-origin navigate refused and moved-origin refused).

## Implementer B — host side (owns src/bridge.cjs, src/gateway.cjs, scripts/install.ps1, tests/bridge_test.cjs, tests/installer_test.py, README.md)
1. Gateway waits up to 10 s for the extension (contract).
2. Pairing mismatch → close(4001, 'profile-mismatch'); corrupt `paired_profile.json` → treat as unpaired? NO: log the error and refuse with 4001 too, never exit silently.
3. `--unpair` command (contract).
4. Gateway errors (EADDRINUSE, ACL, config) are appended to `state/gateway.log` (cap the file at ~256 KB by truncating); bridge's "gateway did not start" message points to that log path.
5. Schema: `browser_key.modifiers.items` → `{type:'string', enum:[...]}`; drop `uniqueItems`; omit `required` when empty.
6. Installer: wrap the MCP config `ConvertFrom-Json` in try/catch with a clear message (config has comments/trailing commas → tell the user to use `agy mcp add` manually, print the exact command); after an upgrade print "Reload the extension in chrome://extensions"; keep only the newest 2 `*.backup_*` dirs of each kind; if `--shutdown` fails, print a manual-kill hint (the node PID if found).
7. README: replace "native-message size limit" with the real limits (800 KB screenshot, 1 MiB message); document `--unpair`, origin lock (re-share after cross-origin moves), and the reload step.
8. Tests for 1–5 and the installer parse-error path.

## Hard rules
- Only edit files you own. No git add/commit/stash/checkout. No new dependencies.
- Run only your own tests: A → `node tests/extension_test.cjs` and `node tests/popup_test.cjs`; B → `node tests/bridge_test.cjs` and `python tests/installer_test.py`. Any gateway you start in tests must use a temp LOCALAPPDATA/state dir and an unused port, and be shut down.
- Do not run scripts/install.ps1 for real and do not touch %LOCALAPPDATA%\agy-chrome-bridge or ~/.gemini.
- Report (<300 words): files changed, what each item does, test results (pass counts), anything not done.
