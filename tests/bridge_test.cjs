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
  const gateway = spawn(process.execPath, [path.join(bridgeDir, 'gateway.cjs')], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let a;
  let b;
  let browser;
  try {
    const endpoint = path.join(local, 'agy-chrome-bridge', 'state', 'endpoint.json');
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
    const unavailable = await a.request(3, 'tools/call', { name: 'browser_tabs', arguments: {} });
    assert.equal(unavailable.result.isError, true);
    assert.match(unavailable.result.content[0].text, /Chrome is not connected/);
    const replay = await connect(port);
    const replayNext = receive(replay);
    await challenge(replay, replayNext, profileKey, capturedProof);
    assert.equal((await new Promise(resolve => replay.once('close', resolve))), 1008);
    const otherProfile = await connect(port);
    const otherNext = receive(otherProfile);
    await challenge(otherProfile, otherNext, 'd'.repeat(64));
    assert.equal((await new Promise(resolve => otherProfile.once('close', resolve))), 1008);

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
    assert.equal((await new Promise(resolve => stillOther.once('close', resolve))), 1008, 'profile pairing survives a gateway restart');
    const finalStop = spawnSync(process.execPath, [bridge, '--shutdown'], { env, windowsHide: true, encoding: 'utf8', timeout: 5000 });
    assert.equal(finalStop.status, 0, finalStop.stderr);
    console.log('Gateway and two MCP clients passed');
  } finally {
    browser?.terminate();
    a?.process.kill();
    b?.process.kill();
    if (gateway.exitCode === null) gateway.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
