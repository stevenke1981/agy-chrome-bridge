'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { WebSocketServer } = require('ws');

const MAX_MESSAGE = 1024 * 1024;
const port = Number(process.env.AGY_BRIDGE_PORT || 38745);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port');
const root = path.join(process.env.LOCALAPPDATA || '', 'agy-chrome-bridge');
const stateDirectory = path.join(root, 'state');
const stateFile = path.join(stateDirectory, 'endpoint.json');
const pairedFile = path.join(stateDirectory, 'paired_profile.json');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'bridge_config.json'), 'utf8'));
if (typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid bridge configuration');
const expectedOrigin = 'chrome-extension://deankghpcmnggohdfkoaggafbmjmkmlj';
const digest = (role, clientNonce, serverNonce, profileKey = '') => crypto.createHmac('sha256', Buffer.from(config.token, 'hex')).update(`${role}:${clientNonce}:${serverNonce}:${profileKey}`).digest('hex');

function restrictState() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA || !process.env.SystemRoot) throw new Error('Windows and LOCALAPPDATA are required');
  const system = path.join(process.env.SystemRoot, 'System32');
  const who = spawnSync(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  if (who.status !== 0) throw new Error('Cannot determine current user SID');
  const sid = who.stdout.trim().split(',').at(-1).replace(/^"|"$/g, '');
  if (!/^S-1-(?:\d+-)*\d+$/.test(sid)) throw new Error('Invalid current user SID');
  const icacls = (args) => {
    const result = spawnSync(path.join(system, 'icacls.exe'), args, { windowsHide: true, stdio: 'ignore' });
    if (result.status !== 0) throw new Error('Cannot restrict bridge state ACL');
  };
  fs.mkdirSync(stateDirectory, { recursive: true });
  icacls([stateDirectory, '/reset']);
  icacls([stateDirectory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
  if (fs.existsSync(stateFile)) icacls([stateFile, '/reset']);
}

function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...args, () => { server.removeListener('error', reject); resolve(); });
  });
}

async function start() {
  restrictState();
  const token = crypto.randomBytes(32).toString('hex');
  let pairedHash = fs.existsSync(pairedFile) ? JSON.parse(fs.readFileSync(pairedFile, 'utf8')).hash : undefined;
  if (pairedHash && !/^[a-f0-9]{64}$/.test(pairedHash)) throw new Error('Invalid paired Chrome profile');
  const pending = new Map();
  let extension;
  const web = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  web.on('upgrade', (request, socket, head) => {
    if (request.url !== '/bridge' || request.headers.origin !== expectedOrigin || request.socket.remoteAddress !== '127.0.0.1') {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client));
  });
  sockets.on('connection', client => {
    let authorized = false;
    let clientNonce;
    let serverNonce;
    client.on('message', (data, isBinary) => {
      if (isBinary || data.length > MAX_MESSAGE) return client.close(1008);
      let message;
      try { message = JSON.parse(data.toString('utf8')); }
      catch { return client.close(1008); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return client.close(1008);
      if (!clientNonce) {
        if (message.type !== 'hello' || typeof message.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(message.nonce)) return client.close(1008);
        clientNonce = message.nonce;
        serverNonce = crypto.randomBytes(32).toString('hex');
        client.send(JSON.stringify({ type: 'challenge', nonce: serverNonce, proof: digest('server', clientNonce, serverNonce) }));
        return;
      }
      if (!authorized) {
        if (message.type !== 'proof' || typeof message.profileKey !== 'string' || !/^[a-f0-9]{64}$/.test(message.profileKey) || typeof message.proof !== 'string' || !/^[a-f0-9]{64}$/.test(message.proof)) return client.close(1008);
        const expected = digest('client', clientNonce, serverNonce, message.profileKey);
        if (!crypto.timingSafeEqual(Buffer.from(message.proof, 'hex'), Buffer.from(expected, 'hex')) || extension) return client.close(1008);
        const hash = crypto.createHash('sha256').update(message.profileKey).digest('hex');
        if (pairedHash && pairedHash !== hash) return client.close(1008);
        if (!pairedHash) {
          fs.writeFileSync(pairedFile, JSON.stringify({ hash }), { mode: 0o600 });
          pairedHash = hash;
        }
        authorized = true;
        extension = client;
        client.send(JSON.stringify({ type: 'ready' }));
        return;
      }
      if (message.type === 'ping') return;
      const target = pending.get(message.id);
      if (target) {
        clearTimeout(target.timer);
        pending.delete(message.id);
        target.socket.end(JSON.stringify(message) + '\n');
      }
    });
    client.on('close', () => {
      if (extension !== client) return;
      extension = undefined;
      for (const [id, target] of pending) {
        clearTimeout(target.timer);
        target.socket.end(JSON.stringify({ error: 'Chrome disconnected' }) + '\n');
        pending.delete(id);
      }
    });
    client.on('error', () => {});
  });
  await listen(web, port, '127.0.0.1');
  const server = net.createServer(socket => {
    let incoming = Buffer.alloc(0);
    let requestId;
    socket.setTimeout(35000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => { if (requestId) { clearTimeout(pending.get(requestId)?.timer); pending.delete(requestId); } });
    socket.on('data', chunk => {
      if (requestId) return;
      incoming = Buffer.concat([incoming, chunk]);
      if (incoming.length > MAX_MESSAGE) return socket.destroy();
      const newline = incoming.indexOf(10);
      if (newline < 0) return;
      let request;
      try { request = JSON.parse(incoming.subarray(0, newline).toString('utf8')); }
      catch { return socket.destroy(); }
      if (!request || typeof request !== 'object' || Array.isArray(request) || request.token !== token || typeof request.method !== 'string') return socket.destroy();
      requestId = crypto.randomBytes(16).toString('hex');
      if (request.method === '__ping') return socket.end(JSON.stringify({ result: { ok: true } }) + '\n');
      if (request.method === '__shutdown') {
        socket.end(JSON.stringify({ result: { ok: true } }) + '\n');
        setTimeout(() => process.exit(0), 50);
        return;
      }
      if (!extension) return socket.end(JSON.stringify({ error: 'Chrome is not connected. Open AGY Chrome Bridge in the selected profile.' }) + '\n');
      const timer = setTimeout(() => { pending.delete(requestId); socket.end(JSON.stringify({ error: 'Chrome did not respond' }) + '\n'); }, 30000);
      pending.set(requestId, { socket, timer });
      extension.send(JSON.stringify({ id: requestId, method: request.method, params: request.params }));
    });
  });
  await listen(server, 0, '127.0.0.1');
  fs.writeFileSync(stateFile, JSON.stringify({ port: server.address().port, token }), { mode: 0o600 });
}

start().catch(error => { process.stderr.write(`agy-chrome-gateway: ${error.message}\n`); process.exit(1); });
