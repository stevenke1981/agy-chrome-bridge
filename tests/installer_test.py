import json
import os
import shutil
import struct
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

SCRIPT = Path('scripts/install.ps1').resolve()


class InstallerTest(unittest.TestCase):
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
            env = {**os.environ, 'LOCALAPPDATA': str(local), 'USERPROFILE': str(profile), 'AGY_TEST_OUTPUT': str(output), 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            try:
                result = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT), '-RegistryPath', registry], capture_output=True, text=True, env=env, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                arguments = output.read_text()
                self.assertIn(str(bridge / 'bridge' / 'bridge.cjs'), arguments)
                self.assertIn('--mcp', arguments)
                self.assertFalse(list(bridge.rglob('*.exe')))
                self.assertEqual(json.loads(config.read_text())['mcpServers']['other']['command'], 'other')
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
            source_extension = root / 'new-extension'
            source_extension.mkdir()
            (source_extension / 'new.txt').write_text('new extension')
            (root / 'agy.cmd').write_text('@exit /b 7\n')
            key_name = 'Software\\AGYChromeBridgeTests\\' + uuid.uuid4().hex
            registry = 'HKCU:\\' + key_name
            env = {**os.environ, 'LOCALAPPDATA': str(local), 'USERPROFILE': str(profile), 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            try:
                result = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT), '-Bridge', str(source_bridge), '-Extension', str(source_extension), '-Node', str(node), '-RegistryPath', registry], capture_output=True, text=True, env=env, timeout=30)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn('registration failed', result.stderr)
                self.assertEqual(installed_bridge.read_text(), 'old bridge')
                self.assertEqual((extension / 'old.txt').read_text(), 'old extension')
                self.assertEqual(config.read_text(encoding='utf-8'), old_config)
                self.assertFalse((extension / 'new.txt').exists())
                check = subprocess.run(['reg', 'query', 'HKCU\\' + key_name], capture_output=True)
                self.assertNotEqual(check.returncode, 0)
            finally:
                subprocess.run(['reg', 'delete', 'HKCU\\' + key_name, '/f'], capture_output=True)

    def test_installed_cmd_launches_node_native_host(self):
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
                host = local / 'agy-chrome-bridge' / 'bridge' / 'host.cmd'
                manifest = json.loads((local / 'agy-chrome-bridge' / 'com.agy_chrome_bridge.json').read_text(encoding='utf-8'))
                self.assertEqual(Path(manifest['path']), host)
                self.assertFalse(list((local / 'agy-chrome-bridge').rglob('*.exe')))
                process = subprocess.Popen(['cmd.exe', '/d', '/c', str(host)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
                try:
                    header = process.stdout.read(4)
                    if len(header) != 4:
                        self.fail(process.stderr.read().decode(errors='replace'))
                    ready = json.loads(process.stdout.read(struct.unpack('<I', header)[0]))
                    self.assertEqual(ready, {'type': 'ready'})
                finally:
                    process.stdin.close()
                    process.wait(timeout=5)
                    process.stdout.close()
                    process.stderr.close()
            finally:
                subprocess.run(['reg', 'delete', 'HKCU\\' + key_name, '/f'], capture_output=True)


if __name__ == '__main__':
    unittest.main()
