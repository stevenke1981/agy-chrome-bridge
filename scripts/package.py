"""Build a Windows release archive using the extension manifest version."""

import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "extension" / "manifest.json").read_text(encoding="utf-8"))
version = manifest["version"]
if not isinstance(version, str) or len(version.split(".")) != 3 or not all(
    part.isdecimal() for part in version.split(".")
):
    raise SystemExit("The extension manifest must contain a numeric major.minor.patch version")

dist = root / "dist"
dist.mkdir(exist_ok=True)
archive = dist / f"agy-chrome-bridge-{version}-windows.zip"
checksum = dist / f"SHA256SUMS-{version}.txt"
if archive.exists() or checksum.exists():
    raise SystemExit(f"Release {version} already exists; increment the manifest version")

sources = {
    "bridge.cjs": root / "src" / "bridge.cjs",
    "gateway.cjs": root / "src" / "gateway.cjs",
    "install.ps1": root / "scripts" / "install.ps1",
    "README.md": root / "README.md",
    "LICENSE": root / "LICENSE",
    "package.json": root / "package.json",
    "package-lock.json": root / "package-lock.json",
    "extension/manifest.json": root / "extension" / "manifest.json",
    "extension/background.js": root / "extension" / "background.js",
    "extension/popup.html": root / "extension" / "popup.html",
    "extension/popup.js": root / "extension" / "popup.js",
}
for size in (16, 32, 48, 128):
    sources[f"extension/icons/icon{size}.png"] = root / "extension" / "icons" / f"icon{size}.png"
for name in (
    "index.js", "package.json", "LICENSE", "lib/buffer-util.js", "lib/constants.js",
    "lib/event-target.js", "lib/extension.js", "lib/limiter.js", "lib/permessage-deflate.js",
    "lib/receiver.js", "lib/sender.js", "lib/stream.js", "lib/subprotocol.js",
    "lib/validation.js", "lib/websocket-server.js", "lib/websocket.js",
):
    sources[f"node_modules/ws/{name}"] = root / "node_modules" / "ws" / name
with ZipFile(archive, "x", compression=ZIP_DEFLATED) as bundle:
    for name, path in sources.items():
        bundle.write(path, name)

digest = hashlib.sha256(archive.read_bytes()).hexdigest()
checksum.write_text(f"{digest}  {archive.name}\n", encoding="ascii")
print(f"Built {archive}")
print(f"SHA-256 {digest}")
