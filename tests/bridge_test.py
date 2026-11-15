import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

EXE = Path(sys.argv.pop(1)).resolve()


def frame_read(pipe):
    header = pipe.read(4)
    if len(header) != 4:
        raise RuntimeError('native host closed unexpectedly')
    return json.loads(pipe.read(struct.unpack('<I', header)[0]))


def frame_write(pipe, value):
    body = json.dumps(value).encode()
    pipe.write(struct.pack('<I', len(body)) + body)
    pipe.flush()


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = {**os.environ, 'LOCALAPPDATA': self.temp.name}
        self.host = subprocess.Popen([str(EXE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        self.assertEqual(frame_read(self.host.stdout), {'type': 'ready'})
        self.endpoint = json.loads((Path(self.temp.name) / 'agy-chrome-bridge' / 'state' / 'endpoint.json').read_text())
        self.mcp = subprocess.Popen([str(EXE), '--mcp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)

    def tearDown(self):
        for proc in (self.host, self.mcp):
            proc.kill()
            proc.communicate(timeout=5)
        self.temp.cleanup()

    def request(self, message):
        self.mcp.stdin.write(json.dumps(message) + '\n')
        self.mcp.stdin.flush()
        return json.loads(self.mcp.stdout.readline())

    def test_initialize_and_tools(self):
        result = self.request({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05'}})
        self.assertEqual(result['result']['protocolVersion'], '2024-11-05')
        result = self.request({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'})
        self.assertIn('browser_snapshot', [tool['name'] for tool in result['result']['tools']])

    def test_request_round_trip_and_error(self):
        def chrome():
            for response in ({'result': [{'id': 12, 'title': 'Example'}]}, {'error': 'Tab is not shared'}):
                request = frame_read(self.host.stdout)
                frame_write(self.host.stdin, {'id': request['id'], **response})
        worker = threading.Thread(target=chrome, daemon=True)
        worker.start()
        first = self.request({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'browser_tabs', 'arguments': {}}})
        self.assertEqual(json.loads(first['result']['content'][0]['text'])[0]['id'], 12)
        second = self.request({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'browser_snapshot', 'arguments': {'tabId': 12}}})
        self.assertTrue(second['result']['isError'])
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())

    def test_rejects_unauthorized_connection_and_second_profile(self):
        with socket.create_connection(('127.0.0.1', self.endpoint['port']), timeout=3) as client:
            client.sendall(b'{"token":"wrong","method":"browser_tabs","params":{}}\n')
            self.assertEqual(client.recv(1), b'')
        other = subprocess.run([str(EXE)], input=b'', capture_output=True, env=self.env, timeout=5)
        self.assertNotEqual(other.returncode, 0)
        self.assertIn(b'another Chrome profile', other.stderr)

    def test_endpoint_acl_is_not_inherited(self):
        state = Path(self.temp.name) / 'agy-chrome-bridge' / 'state' / 'endpoint.json'
        acl = subprocess.run(['icacls', str(state)], capture_output=True, text=True, check=True).stdout
        self.assertNotIn('CodexSandboxUsers', acl)
        self.assertIn('(I)', acl)  # The file inherits the restricted state-directory ACL.
        directory_acl = subprocess.run(['icacls', str(state.parent)], capture_output=True, text=True, check=True).stdout
        self.assertNotIn('CodexSandboxUsers', directory_acl)
        self.assertNotIn(':(I)', directory_acl)


if __name__ == '__main__':
    unittest.main()
