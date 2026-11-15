import json
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

SCRIPT = Path('scripts/install.ps1').resolve()


class InstallerTest(unittest.TestCase):
    def test_failed_upgrade_restores_previous_installation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            local = root / 'local'
            profile = root / 'profile'
            bridge = local / 'agy-chrome-bridge'
            binary = bridge / 'bin' / 'agy-chrome-bridge.exe'
            extension = bridge / 'extension'
            config = profile / '.gemini' / 'config' / 'mcp_config.json'
            for directory in (binary.parent, extension, config.parent):
                directory.mkdir(parents=True)
            binary.write_bytes(b'old binary')
            (extension / 'old.txt').write_text('old extension')
            old_config = json.dumps({'mcpServers': {'agy-chrome-bridge': {'command': str(binary)}, 'other': {'command': 'other'}}})
            config.write_text(old_config)
            source_binary = root / 'new.exe'
            source_binary.write_bytes(b'new binary')
            source_extension = root / 'new-extension'
            source_extension.mkdir()
            (source_extension / 'new.txt').write_text('new extension')
            (root / 'agy.cmd').write_text('@exit /b 7\n')
            key_name = 'Software\\AGYChromeBridgeTests\\' + uuid.uuid4().hex
            registry = 'HKCU:\\' + key_name
            env = {**os.environ, 'LOCALAPPDATA': str(local), 'USERPROFILE': str(profile), 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            try:
                result = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT), '-Binary', str(source_binary), '-Extension', str(source_extension), '-RegistryPath', registry], capture_output=True, text=True, env=env, timeout=30)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn('registration failed', result.stderr)
                self.assertEqual(binary.read_bytes(), b'old binary')
                self.assertEqual((extension / 'old.txt').read_text(), 'old extension')
                self.assertEqual(config.read_text(), old_config)
                self.assertFalse((extension / 'new.txt').exists())
                check = subprocess.run(['reg', 'query', 'HKCU\\' + key_name], capture_output=True)
                self.assertNotEqual(check.returncode, 0)
            finally:
                subprocess.run(['reg', 'delete', 'HKCU\\' + key_name, '/f'], capture_output=True)


if __name__ == '__main__':
    unittest.main()
