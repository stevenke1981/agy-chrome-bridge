const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');

const token = 'a'.repeat(64);
const profileKey = 'c'.repeat(64);
const origin = 'chrome-extension://deankghpcmnggohdfkoaggafbmjmkmlj';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const proof = (role, clientNonce, serverNonce, profile = '') => crypto.createHmac('sha256', Buffer.from(token, 'hex')).update(`${role}:${clientNonce}:${serverNonce}:${profile}`).digest('hex');

function mcp(command, env) {
  const child = spawn(process.execPath, [command, '--mcp'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let input = '';
  child.stdout.on('data', chunk => {
    input += chunk;
    while (input.includes('\n')) {
      const index = input.indexOf('\n');
      const message = JSON.parse(input.slice(0, index));
      input = input.slice(index + 1);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  return {
    process: child,
    request(id, method, params = {}) {
      return new Promise(resolve => {
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
  };
}

async function connect(port, headerOrigin = origin) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: headerOrigin });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return socket;
}

function receive(socket) {
  const queue = [];
  const waiters = [];
  socket.on('message', data => {
    const value = JSON.parse(data.toString('utf8'));
    if (waiters.length) waiters.shift()(value);
    else queue.push(value);
  });
  return () => new Promise(resolve => {
    if (queue.length) resolve(queue.shift());
    else waiters.push(resolve);
  });
}

function closedWith(socket) {
  return new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') })));
}

function exited(child) {
  return child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise(resolve => child.once('exit', resolve));
}

async function challenge(socket, next, profile = profileKey, overrideProof) {
  const clientNonce = crypto.randomBytes(32).toString('hex');
  socket.send(JSON.stringify({ type: 'hello', nonce: clientNonce }));
  const reply = await next();
  assert.equal(reply.type, 'challenge');
  assert.equal(reply.proof, proof('server', clientNonce, reply.nonce));
  const sent = overrideProof || proof('client', clientNonce, reply.nonce, profile);
  socket.send(JSON.stringify({ type: 'proof', profileKey: profile, proof: sent }));
  return sent;
}

async function startGateway(gatewayPath, env, endpoint) {
  fs.rmSync(endpoint, { force: true });
  const child = spawn(process.execPath, [gatewayPath], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  for (let attempt = 0; attempt < 50 && !fs.existsSync(endpoint) && child.exitCode === null; attempt++) await wait(100);
  return child;
}

async function checkWaitingCallCompletesOnReconnect(port, pendingCall) {
  await wait(1000);
  const returned = await connect(port);
  const next = receive(returned);
  await challenge(returned, next);
  assert.deepEqual(await next(), { type: 'ready' });
  const forwarded = await next();
  assert.equal(forwarded.method, 'browser_tabs');
  returned.send(JSON.stringify({ id: forwarded.id, result: [] }));
  assert.deepEqual(JSON.parse((await pendingCall).result.content[0].text), []);
  const closed = closedWith(returned);
  returned.close();
  await closed;
  await wait(100);
}

async function checkUnreadablePairing({ env, bridge, gatewayPath, port, stateDir }) {
  const endpoint = path.join(stateDir, 'endpoint.json');
  const paired = path.join(stateDir, 'paired_profile.json');
  fs.writeFileSync(paired, '{not json');
  const gateway = await startGateway(gatewayPath, env, endpoint);
  try {
    assert.ok(fs.existsSync(endpoint), 'gateway must start even when the pairing file is unreadable');
    const socket = await connect(port);
    const next = receive(socket);
    await challenge(socket, next);
    assert.deepEqual(await closedWith(socket), { code: 4001, reason: 'profile-mismatch' });
    assert.match(fs.readFileSync(path.join(stateDir, 'gateway.log'), 'utf8'), /paired_profile\.json/);
    const unpaired = spawnSync(process.execPath, [bridge, '--unpair'], { env, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(unpaired.status, 0, unpaired.stderr);
    assert.match(unpaired.stdout, /Stopped the gateway/);
    assert.match(unpaired.stdout, /Removed the paired Chrome profile/);
    assert.equal(fs.existsSync(paired), false);
    assert.equal(await exited(gateway), 0);
    const again = spawnSync(process.execPath, [bridge, '--unpair'], { env, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Gateway was not running/);
    assert.match(again.stdout, /No paired Chrome profile/);
  } finally {
    if (gateway.exitCode === null) gateway.kill();
  }
}

async function checkGatewayLogLimit({ gatewayPath, env, temp }) {
  const busy = net.createServer();
  await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve));
  const busyRoot = path.join(temp, 'busy');
  const stateDir = path.join(busyRoot, 'agy-chrome-bridge', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const log = path.join(stateDir, 'gateway.log');
  fs.writeFileSync(log, 'stale line\n'.repeat(30000));
  try {
    const busyEnv = { ...env, LOCALAPPDATA: busyRoot, AGY_BRIDGE_PORT: String(busy.address().port) };
    const result = spawnSync(process.execPath, [gatewayPath], { env: busyEnv, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    const text = fs.readFileSync(log, 'utf8');
    assert.match(text, /EADDRINUSE/);
    assert.doesNotMatch(text, /stale line/);
    assert.ok(Buffer.byteLength(text) <= 256 * 1024, 'gateway log must stay near 256 KB');
  } finally {
    await new Promise(resolve => busy.close(resolve));
  }
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-測試-🧪-'));
  const bridgeDir = path.join(temp, 'bridge');
  const extensionDir = path.join(temp, 'extension');
  const local = path.join(temp, 'local');
  fs.mkdirSync(bridgeDir);
  fs.mkdirSync(extensionDir);
  fs.copyFileSync('src/bridge.cjs', path.join(bridgeDir, 'bridge.cjs'));
  fs.copyFileSync('src/gateway.cjs', path.join(bridgeDir, 'gateway.cjs'));
  fs.copyFileSync('extension/manifest.json', path.join(extensionDir, 'manifest.json'));
  fs.writeFileSync(path.join(extensionDir, 'bridge_config.json'), JSON.stringify({ token }));
  const available = net.createServer();
  await new Promise(resolve => available.listen(0, '127.0.0.1', resolve));
  const port = available.address().port;
  await new Promise(resolve => available.close(resolve));
  const env = { ...process.env, LOCALAPPDATA: local, NODE_PATH: path.resolve('node_modules'), AGY_BRIDGE_PORT: String(port) };
  const bridge = path.join(bridgeDir, 'bridge.cjs');
  const gatewayPath = path.join(bridgeDir, 'gateway.cjs');
  const gateway = spawn(process.execPath, [gatewayPath], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let a;
  let b;
  let browser;
  try {
    const stateDir = path.join(local, 'agy-chrome-bridge', 'state');
    const endpoint = path.join(stateDir, 'endpoint.json');
    for (let attempt = 0; attempt < 50 && !fs.existsSync(endpoint); attempt++) await wait(100);
    assert.ok(fs.existsSync(endpoint), 'gateway must create its protected endpoint');
    const address = JSON.parse(fs.readFileSync(endpoint, 'utf8'));
    assert.match(address.token, /^[a-f0-9]{64}$/);
    assert.notEqual(address.token, token);
    const unauthorized = net.createConnection({ host: '127.0.0.1', port: address.port });
    let rejected = '';
    unauthorized.on('data', chunk => { rejected += chunk; });
    await new Promise(resolve => {
      unauthorized.once('connect', () => unauthorized.write(JSON.stringify({ token: 'wrong', method: '__ping' }) + '\n'));
      unauthorized.once('close', resolve);
    });
    assert.equal(rejected, '');

    const wrongOrigin = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: 'https://example.com' });
    const denied = await new Promise(resolve => {
      wrongOrigin.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      wrongOrigin.once('error', () => {});
    });
    assert.equal(denied, 403);

    const wrongToken = await connect(port);
    const wrongNext = receive(wrongToken);
    await challenge(wrongToken, wrongNext, profileKey, 'b'.repeat(64));
    assert.equal((await new Promise(resolve => wrongToken.once('close', resolve))), 1008);
    const malformed = await connect(port);
    malformed.send('null');
    assert.equal((await new Promise(resolve => malformed.once('close', resolve))), 1008);
    assert.equal(gateway.exitCode, null, 'malformed client input must not stop the gateway');
    const arrayNonce = await connect(port);
    arrayNonce.send(JSON.stringify({ type: 'hello', nonce: ['a'.repeat(64)] }));
    assert.equal((await new Promise(resolve => arrayNonce.once('close', resolve))), 1008);
    const arrayProfile = await connect(port);
    const arrayNext = receive(arrayProfile);
    await challenge(arrayProfile, arrayNext, [profileKey]);
    assert.equal((await new Promise(resolve => arrayProfile.once('close', resolve))), 1008);
    assert.equal(gateway.exitCode, null, 'type-confused client input must not stop the gateway');

    browser = await connect(port);
    const next = receive(browser);
    const capturedProof = await challenge(browser, next);
    assert.deepEqual(await next(), { type: 'ready' });
    const competing = await connect(port);
    const competingNext = receive(competing);
    await challenge(competing, competingNext);
    assert.equal((await new Promise(resolve => competing.once('close', resolve))), 1008);

    a = mcp(bridge, env);
    b = mcp(bridge, env);
    const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
    assert.equal((await a.request(1, 'initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.version, manifest.version);
    assert.ok((await b.request(1, 'tools/list')).result.tools.some(tool => tool.name === 'browser_tabs'));
    const listed = (await b.request(6, 'tools/list')).result.tools;
    const keySchema = listed.find(tool => tool.name === 'browser_key').inputSchema;
    assert.deepEqual(keySchema.properties.modifiers, { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } });
    assert.ok(!('uniqueItems' in keySchema.properties.modifiers));
    assert.ok(!('required' in listed.find(tool => tool.name === 'browser_tabs').inputSchema));

    const first = a.request(2, 'tools/call', { name: 'browser_tabs', arguments: {} });
    const second = b.request(2, 'tools/call', { name: 'browser_snapshot', arguments: { tabId: 7 } });
    const sent = [await next(), await next()];
    const tabs = sent.find(item => item.method === 'browser_tabs');
    const snapshot = sent.find(item => item.method === 'browser_snapshot');
    assert.ok(tabs && snapshot && tabs.id !== snapshot.id);
    browser.send(JSON.stringify({ id: snapshot.id, result: { title: 'Example' } }));
    browser.send(JSON.stringify({ id: tabs.id, result: [{ id: 7, title: 'Example' }] }));
    assert.equal(JSON.parse((await first).result.content[0].text)[0].id, 7);
    assert.equal(JSON.parse((await second).result.content[0].text).title, 'Example');

    const closed = new Promise(resolve => browser.once('close', resolve));
    browser.close();
    await closed;
    const startedAt = Date.now();
    const unavailable = await a.request(3, 'tools/call', { name: 'browser_tabs', arguments: {} });
    assert.ok(Date.now() - startedAt >= 29500, 'gateway must wait about 30 s for the extension');
    assert.equal(unavailable.result.isError, true);
    assert.match(unavailable.result.content[0].text, /Chrome is not connected/);
    await checkWaitingCallCompletesOnReconnect(port, a.request(5, 'tools/call', { name: 'browser_tabs', arguments: {} }));

    const replay = await connect(port);
    const replayNext = receive(replay);
    await challenge(replay, replayNext, profileKey, capturedProof);
    assert.equal((await new Promise(resolve => replay.once('close', resolve))), 1008);
    const otherProfile = await connect(port);
    const otherNext = receive(otherProfile);
    await challenge(otherProfile, otherNext, 'd'.repeat(64));
    assert.deepEqual(await closedWith(otherProfile), { code: 4001, reason: 'profile-mismatch' });

    const stopped = spawnSync(process.execPath, [bridge, '--shutdown'], { env, windowsHide: true, encoding: 'utf8', timeout: 5000 });
    assert.equal(stopped.status, 0, stopped.stderr);
    if (gateway.exitCode === null) await new Promise(resolve => gateway.once('exit', resolve));
    assert.equal(gateway.exitCode, 0);
    const restarted = await a.request(4, 'tools/call', { name: 'browser_tabs', arguments: {} });
    assert.equal(restarted.result.isError, true);
    assert.match(restarted.result.content[0].text, /Chrome is not connected/);
    const stillOther = await connect(port);
    const stillOtherNext = receive(stillOther);
    await challenge(stillOther, stillOtherNext, 'd'.repeat(64));
    assert.deepEqual(await closedWith(stillOther), { code: 4001, reason: 'profile-mismatch' }, 'profile pairing survives a gateway restart');
    const finalStop = spawnSync(process.execPath, [bridge, '--shutdown'], { env, windowsHide: true, encoding: 'utf8', timeout: 5000 });
    assert.equal(finalStop.status, 0, finalStop.stderr);

    await checkUnreadablePairing({ env, bridge, gatewayPath, port, stateDir });
    await checkGatewayLogLimit({ gatewayPath, env, temp });
    console.log('Gateway and two MCP clients passed');
  } finally {
    browser?.terminate();
    a?.process.kill();
    b?.process.kill();
    if (gateway.exitCode === null) gateway.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
