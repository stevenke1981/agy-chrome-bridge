'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { WebSocketServer } = require('ws');

const MAX_MESSAGE = 1024 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
const EXTENSION_WAIT_MS = 10000;
const REQUEST_TIMEOUT_MS = 30000;
const SOCKET_TIMEOUT_MS = 35000;
const NOT_CONNECTED = 'Chrome is not connected. Open AGY Chrome Bridge in the selected profile.';
const PROFILE_MISMATCH = { code: 4001, reason: 'profile-mismatch' };
const root = path.join(process.env.LOCALAPPDATA || '', 'agy-chrome-bridge');
const stateDirectory = path.join(root, 'state');
const stateFile = path.join(stateDirectory, 'endpoint.json');
const pairedFile = path.join(stateDirectory, 'paired_profile.json');
const logFile = path.join(stateDirectory, 'gateway.log');
const state = { token: undefined, extension: undefined, pairedHash: undefined, pairingError: undefined };
const pending = new Map();
const connectionWaiters = new Set();

process.on('uncaughtException', error => { logError(error.stack || error.message); process.exit(1); });

const port = Number(process.env.AGY_BRIDGE_PORT || 38745);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'bridge_config.json'), 'utf8'));
if (typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid bridge configuration');
const expectedOrigin = 'chrome-extension://deankghpcmnggohdfkoaggafbmjmkmlj';
const digest = (role, clientNonce, serverNonce, profileKey = '') => crypto.createHmac('sha256', Buffer.from(config.token, 'hex')).update(`${role}:${clientNonce}:${serverNonce}:${profileKey}`).digest('hex');
const isHex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function appendLog(line) {
  fs.mkdirSync(stateDirectory, { recursive: true });
  const size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const truncate = size + Buffer.byteLength(line) > MAX_LOG_BYTES;
  fs.writeFileSync(logFile, line, { flag: truncate ? 'w' : 'a', mode: 0o600 });
}

function logError(message) {
  process.stderr.write(`agy-chrome-gateway: ${message}\n`);
  try { appendLog(`${new Date().toISOString()} ${message}\n`); }
  catch (error) { process.stderr.write(`agy-chrome-gateway: cannot write ${logFile}: ${error.message}\n`); }
}

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

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

function readPairing() {
  if (!fs.existsSync(pairedFile)) return {};
  try {
    const { hash } = JSON.parse(fs.readFileSync(pairedFile, 'utf8'));
    if (!isHex64(hash)) throw new Error('hash is not a SHA-256 hex digest');
    return { hash };
  } catch (error) {
    return { error: `Cannot read paired_profile.json (${error.message}). Run bridge.cjs --unpair to reset the pairing.` };
  }
}

function pairingRefusal(hash) {
  if (state.pairingError) return state.pairingError;
  if (state.pairedHash && state.pairedHash !== hash) return 'a different Chrome profile tried to connect';
  return undefined;
}

function finishRequest(id, payload) {
  const target = pending.get(id);
  if (!target) return;
  clearTimeout(target.timer);
  pending.delete(id);
  target.socket.end(JSON.stringify(payload) + '\n');
}

function cancelRequest(id) {
  if (!id) return;
  clearTimeout(pending.get(id)?.timer);
  pending.delete(id);
}

function dropExtension() {
  state.extension = undefined;
  for (const id of [...pending.keys()]) finishRequest(id, { error: 'Chrome disconnected' });
}

function wakeWaiters() {
  for (const wake of [...connectionWaiters]) wake();
}

function waitForExtension() {
  if (state.extension) return Promise.resolve(true);
  return new Promise(resolve => {
    const wake = () => { clearTimeout(timer); connectionWaiters.delete(wake); resolve(Boolean(state.extension)); };
    const timer = setTimeout(wake, EXTENSION_WAIT_MS);
    connectionWaiters.add(wake);
  });
}

function handleHello(client, session, message) {
  if (message.type !== 'hello' || !isHex64(message.nonce)) return client.close(1008);
  session.clientNonce = message.nonce;
  session.serverNonce = crypto.randomBytes(32).toString('hex');
  client.send(JSON.stringify({ type: 'challenge', nonce: session.serverNonce, proof: digest('server', session.clientNonce, session.serverNonce) }));
}

function handleProof(client, session, message) {
  if (message.type !== 'proof' || !isHex64(message.profileKey) || !isHex64(message.proof)) return client.close(1008);
  const expected = digest('client', session.clientNonce, session.serverNonce, message.profileKey);
  if (!crypto.timingSafeEqual(Buffer.from(message.proof, 'hex'), Buffer.from(expected, 'hex')) || state.extension) return client.close(1008);
  const hash = crypto.createHash('sha256').update(message.profileKey).digest('hex');
  const refusal = pairingRefusal(hash);
  if (refusal) {
    logError(`Refused extension connection: ${refusal}`);
    return client.close(PROFILE_MISMATCH.code, PROFILE_MISMATCH.reason);
  }
  if (!state.pairedHash) {
    fs.writeFileSync(pairedFile, JSON.stringify({ hash }), { mode: 0o600 });
    state.pairedHash = hash;
  }
  session.authorized = true;
  state.extension = client;
  wakeWaiters();
  client.send(JSON.stringify({ type: 'ready' }));
}

function handleClient(client) {
  const session = { authorized: false };
  client.on('message', (data, isBinary) => {
    if (isBinary || data.length > MAX_MESSAGE) return client.close(1008);
    const message = parseObject(data.toString('utf8'));
    if (!message) return client.close(1008);
    if (!session.clientNonce) return handleHello(client, session, message);
    if (!session.authorized) return handleProof(client, session, message);
    if (message.type === 'ping') return;
    finishRequest(message.id, message);
  });
  client.on('close', () => { if (state.extension === client) dropExtension(); });
  client.on('error', () => {});
}

async function routeToExtension(socket, requestId, request) {
  const connected = await waitForExtension();
  if (socket.destroyed) return;
  if (!connected || !state.extension) return socket.end(JSON.stringify({ error: NOT_CONNECTED }) + '\n');
  const timer = setTimeout(() => finishRequest(requestId, { error: 'Chrome did not respond' }), REQUEST_TIMEOUT_MS);
  pending.set(requestId, { socket, timer });
  state.extension.send(JSON.stringify({ id: requestId, method: request.method, params: request.params }));
}

function handleRequest(socket, requestId, request) {
  if (request.method === '__ping') return socket.end(JSON.stringify({ result: { ok: true } }) + '\n');
  if (request.method === '__shutdown') {
    socket.end(JSON.stringify({ result: { ok: true } }) + '\n');
    setTimeout(() => process.exit(0), 50);
    return;
  }
  routeToExtension(socket, requestId, request).catch(error => logError(`Request routing failed: ${error.message}`));
}

function handleLocalSocket(socket) {
  const session = { incoming: Buffer.alloc(0), requestId: undefined };
  socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('close', () => cancelRequest(session.requestId));
  socket.on('data', chunk => {
    if (session.requestId) return;
    session.incoming = Buffer.concat([session.incoming, chunk]);
    if (session.incoming.length > MAX_MESSAGE) return socket.destroy();
    const newline = session.incoming.indexOf(10);
    if (newline < 0) return;
    const request = parseObject(session.incoming.subarray(0, newline).toString('utf8'));
    if (!request || request.token !== state.token || typeof request.method !== 'string') return socket.destroy();
    session.requestId = crypto.randomBytes(16).toString('hex');
    handleRequest(socket, session.requestId, request);
  });
}

async function start() {
  restrictState();
  state.token = crypto.randomBytes(32).toString('hex');
  const paired = readPairing();
  state.pairedHash = paired.hash;
  state.pairingError = paired.error;
  if (paired.error) logError(paired.error);
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
  sockets.on('connection', handleClient);
  await listen(web, port, '127.0.0.1');
  const server = net.createServer(handleLocalSocket);
  await listen(server, 0, '127.0.0.1');
  fs.writeFileSync(stateFile, JSON.stringify({ port: server.address().port, token: state.token }), { mode: 0o600 });
}

start().catch(error => { logError(error.message); process.exit(1); });
