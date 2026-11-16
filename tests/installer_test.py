import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import uuid
import winreg
from pathlib import Path

SCRIPT = Path('scripts/install.ps1').resolve()


class InstallerTest(unittest.TestCase):
    def test_upgrades_existing_bridge_when_node_path_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            local = root / 'local'
            profile = root / 'profile'
            bridge = local / 'agy-chrome-bridge'
            config = profile / '.gemini' / 'config' / 'mcp_config.json'
            config.parent.mkdir(parents=True)
            old_node = root / 'previous_node' / 'node.exe'
            config.write_text(json.dumps({'mcpServers': {'agy-chrome-bridge': {'command': str(old_node), 'args': [str(bridge / 'bridge' / 'bridge.cjs'), '--mcp']}}}))
            (root / 'agy.cmd').write_text('@exit /b 0\n')
            key_name = 'Software\\AGYChromeBridgeTests\\' + uuid.uuid4().hex
            env = {**os.environ, 'LOCALAPPDATA': str(local), 'USERPROFILE': str(profile), 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            try:
                result = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT), '-RegistryPath', 'HKCU:\\' + key_name], capture_output=True, text=True, env=env, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue((bridge / 'bridge' / 'gateway.cjs').is_file())
                self.assertRegex(json.loads((bridge / 'extension' / 'bridge_config.json').read_text())['token'], r'^[a-f0-9]{64}$')
            finally:
                subprocess.run(['reg', 'delete', 'HKCU\\' + key_name, '/f'], capture_output=True)

    def test_migrates_legacy_configuration_to_existing_node(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            local = root / 'local'
            profile = root / 'profile'
            bridge = local / 'agy-chrome-bridge'
            config = profile / '.gemini' / 'config' / 'mcp_config.json'
            config.parent.mkdir(parents=True)
            legacy = bridge / 'bin' / 'agy-chrome-bridge.exe'
            config.write_text(json.dumps({'mcpServers': {'agy-chrome-bridge': {'command': str(legacy)}, 'other': {'command': 'other'}}}))
            (root / 'agy.cmd').write_text('@echo off\necho %* > "%AGY_TEST_OUTPUT%"\nexit /b 0\n')
            output = root / 'agy-args.txt'
            key_name = 'Software\\AGYChromeBridgeTests\\' + uuid.uuid4().hex
            registry = 'HKCU:\\' + key_name
            bridge.mkdir(parents=True)
            old_manifest = bridge / 'com.agy_chrome_bridge.json'
            old_manifest.write_text('old native host')
            registered = subprocess.run(['reg', 'add', 'HKCU\\' + key_name, '/ve', '/t', 'REG_SZ', '/d', str(old_manifest), '/f'], capture_output=True, text=True)
            self.assertEqual(registered.returncode, 0, registered.stderr)
            env = {**os.environ, 'LOCALAPPDATA': str(local), 'USERPROFILE': str(profile), 'AGY_TEST_OUTPUT': str(output), 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            try:
                result = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT), '-RegistryPath', registry], capture_output=True, text=True, env=env, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                arguments = output.read_text()
                self.assertIn(str(bridge / 'bridge' / 'bridge.cjs'), arguments)
                self.assertIn('--mcp', arguments)
                self.assertFalse(list(bridge.rglob('*.exe')))
                self.assertEqual(json.loads(config.read_text())['mcpServers']['other']['command'], 'other')
                self.assertFalse(old_manifest.exists())
                self.assertTrue(list(bridge.glob('com.agy_chrome_bridge.json.backup_*')))
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_name) as key:
                    with self.assertRaises(FileNotFoundError):
                        winreg.QueryValueEx(key, '')
            finally:
                subprocess.run(['reg', 'delete', 'HKCU\\' + key_name, '/f'], capture_output=True)

    def test_failed_upgrade_restores_previous_installation(self):
        with tempfile.TemporaryDirectory(prefix='agy-測試-🧪-') as temp:
            root = Path(temp)
            local = root / 'local'
            profile = root / 'profile'
            bridge = local / 'agy-chrome-bridge'
            installed_bridge = bridge / 'bridge' / 'bridge.cjs'
            extension = bridge / 'extension'
            config = profile / '.gemini' / 'config' / 'mcp_config.json'
            node = Path(shutil.which('node')).resolve()
            for directory in (installed_bridge.parent, extension, config.parent):
                directory.mkdir(parents=True)
            installed_bridge.write_text('old bridge')
            (extension / 'old.txt').write_text('old extension')
            old_config = json.dumps({'mcpServers': {'agy-chrome-bridge': {'command': str(node), 'args': [str(installed_bridge), '--mcp']}, 'other': {'command': 'other'}}}, ensure_ascii=False)
            config.write_text(old_config, encoding='utf-8')
            source_bridge = root / 'new.cjs'
            source_bridge.write_text('new bridge')
            source_extension = Path('extension').resolve()
            (root / 'agy.cmd').write_text('@exit /b 7\n')
            key_name = 'Software\\AGYChromeBridgeTests\\' + uuid.uuid4().hex
            registry = 'HKCU:\\' + key_name
            old_manifest = bridge / 'com.agy_chrome_bridge.json'
            old_manifest.write_text('old native host')
            self.assertEqual(subprocess.run(['reg', 'add', 'HKCU\\' + key_name, '/ve', '/t', 'REG_SZ', '/d', str(old_manifest), '/f'], capture_output=True).returncode, 0)
            self.assertEqual(subprocess.run(['reg', 'add', 'HKCU\\' + key_name, '/v', 'Marker', '/t', 'REG_SZ', '/d', 'keep', '/f'], capture_output=True).returncode, 0)
            env = {**os.environ, 'LOCALAPPDATA': str(local), 'USERPROFILE': str(profile), 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            try:
                result = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT), '-Bridge', str(source_bridge), '-Extension', str(source_extension), '-Node', str(node), '-RegistryPath', registry], capture_output=True, text=True, env=env, timeout=30)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn('registration failed', result.stderr)
                self.assertEqual(installed_bridge.read_text(), 'old bridge')
                self.assertEqual((extension / 'old.txt').read_text(), 'old extension')
                self.assertEqual(config.read_text(encoding='utf-8'), old_config)
                self.assertFalse((extension / 'manifest.json').exists())
                self.assertEqual(old_manifest.read_text(), 'old native host')
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_name) as key:
                    self.assertEqual(winreg.QueryValueEx(key, '')[0], str(old_manifest))
                    self.assertEqual(winreg.QueryValueEx(key, 'Marker')[0], 'keep')
            finally:
                subprocess.run(['reg', 'delete', 'HKCU\\' + key_name, '/f'], capture_output=True)

    def test_installed_gateway_launches_existing_node(self):
        with tempfile.TemporaryDirectory(prefix='agy-測試-🧪-') as temp:
            root = Path(temp)
            local = root / 'local'
            profile = root / 'profile'
            local.mkdir()
            profile.mkdir()
            (root / 'agy.cmd').write_text('@exit /b 0\n')
            key_name = 'Software\\AGYChromeBridgeTests\\' + uuid.uuid4().hex
            registry = 'HKCU:\\' + key_name
            env = {**os.environ, 'LOCALAPPDATA': str(local), 'USERPROFILE': str(profile), 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            try:
                result = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT), '-RegistryPath', registry], capture_output=True, text=True, env=env, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                installed = local / 'agy-chrome-bridge'
                gateway = installed / 'bridge' / 'gateway.cjs'
                client = installed / 'bridge' / 'bridge.cjs'
                config = json.loads((installed / 'extension' / 'bridge_config.json').read_text(encoding='utf-8'))
                self.assertRegex(config['token'], r'^[a-f0-9]{64}$')
                self.assertTrue(gateway.is_file())
                self.assertFalse(list((local / 'agy-chrome-bridge').rglob('*.exe')))
                with socket.socket() as available:
                    available.bind(('127.0.0.1', 0))
                    env['AGY_BRIDGE_PORT'] = str(available.getsockname()[1])
                process = subprocess.Popen([shutil.which('node'), str(gateway)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
                try:
                    endpoint = installed / 'state' / 'endpoint.json'
                    for _ in range(50):
                        if endpoint.exists():
                            break
                        time.sleep(0.1)
                    self.assertTrue(endpoint.exists(), process.poll())
                    stopped = subprocess.run([shutil.which('node'), str(client), '--shutdown'], capture_output=True, text=True, env=env, timeout=10)
                    self.assertEqual(stopped.returncode, 0, stopped.stderr)
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=5)
                    process.stdout.close()
                    process.stderr.close()
            finally:
                subprocess.run(['reg', 'delete', 'HKCU\\' + key_name, '/f'], capture_output=True)

    def test_prunes_old_backups_and_prints_reload_hint(self):
        with tempfile.TemporaryDirectory(prefix='agy-測試-🧪-') as temp:
            root = Path(temp)
            local = root / 'local'
            profile = root / 'profile'
            bridge = local / 'agy-chrome-bridge'
            (bridge / 'bridge').mkdir(parents=True)
            (bridge / 'bridge' / 'bridge.cjs').write_text('previous bridge')
            for index in range(3):
                (bridge / f'bridge.backup_20200101_000000_00{index}').mkdir()
            config = profile / '.gemini' / 'config' / 'mcp_config.json'
            config.parent.mkdir(parents=True)
            (root / 'agy.cmd').write_text('@exit /b 0\n')
            key_name = 'Software\\AGYChromeBridgeTests\\' + uuid.uuid4().hex
            env = {**os.environ, 'LOCALAPPDATA': str(local), 'USERPROFILE': str(profile), 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            try:
                result = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT), '-RegistryPath', 'HKCU:\\' + key_name], capture_output=True, text=True, env=env, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                backups = sorted(path.name for path in bridge.glob('bridge.backup_*'))
                self.assertEqual(len(backups), 2, backups)
                self.assertNotIn('bridge.backup_20200101_000000_000', backups)
                self.assertNotIn('bridge.backup_20200101_000000_001', backups)
                self.assertIn('Reload the extension in chrome://extensions', result.stdout)
            finally:
                subprocess.run(['reg', 'delete', 'HKCU\\' + key_name, '/f'], capture_output=True)

    def test_unparseable_mcp_config_fails_before_changes(self):
        with tempfile.TemporaryDirectory(prefix='agy-測試-🧪-') as temp:
            root = Path(temp)
            local = root / 'local'
            profile = root / 'profile'
            bridge = local / 'agy-chrome-bridge'
            config = profile / '.gemini' / 'config' / 'mcp_config.json'
            config.parent.mkdir(parents=True)
            original = '{\n  // comment\n  "mcpServers": {"other": {"command": "other"},},\n}\n'
            config.write_text(original, encoding='utf-8')
            (root / 'agy.cmd').write_text('@exit /b 0\n')
            key_name = 'Software\\AGYChromeBridgeTests\\' + uuid.uuid4().hex
            env = {**os.environ, 'LOCALAPPDATA': str(local), 'USERPROFILE': str(profile), 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            try:
                result = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT), '-RegistryPath', 'HKCU:\\' + key_name], capture_output=True, text=True, env=env, timeout=30)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn('agy mcp add agy-chrome-bridge', result.stderr)
                self.assertEqual(config.read_text(encoding='utf-8'), original)
                self.assertFalse((bridge / 'bridge').exists())
                self.assertFalse((bridge / 'extension').exists())
            finally:
                subprocess.run(['reg', 'delete', 'HKCU\\' + key_name, '/f'], capture_output=True)


if __name__ == '__main__':
    unittest.main()
