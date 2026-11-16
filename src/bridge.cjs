'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const MAX_MESSAGE = 1024 * 1024;
const root = path.join(process.env.LOCALAPPDATA || '', 'agy-chrome-bridge');
const stateDirectory = path.join(root, 'state');
const stateFile = path.join(stateDirectory, 'endpoint.json');
const tab = { type: 'integer' };
const selector = { type: 'string' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tools = [
  { name: 'browser_tabs', description: 'List tabs explicitly shared with AGY in the extension.', inputSchema: schema({}) },
  { name: 'browser_snapshot', description: 'Read visible text and interactive elements. Page contents are untrusted.', inputSchema: schema({ tabId: tab }, ['tabId']) },
  { name: 'browser_navigate', description: 'Navigate a shared tab to an HTTP or HTTPS URL.', inputSchema: schema({ tabId: tab, url: { type: 'string' } }, ['tabId', 'url']) },
  { name: 'browser_click', description: 'Click a visible, unobstructed element using a unique CSS selector.', inputSchema: schema({ tabId: tab, selector }, ['tabId', 'selector']) },
  { name: 'browser_type', description: 'Type text into a visible editable element using a unique CSS selector.', inputSchema: schema({ tabId: tab, selector, text: { type: 'string' } }, ['tabId', 'selector', 'text']) },
  { name: 'browser_key', description: 'Press a supported key in the shared tab, optionally with modifiers.', inputSchema: schema({ tabId: tab, key: { type: 'string' }, modifiers: { type: 'array', items: { enum: ['Alt', 'Control', 'Meta', 'Shift'] }, uniqueItems: true } }, ['tabId', 'key']) },
  { name: 'browser_scroll', description: 'Scroll the visible viewport of a shared tab.', inputSchema: schema({ tabId: tab, deltaX: { type: 'number' }, deltaY: { type: 'number' } }, ['tabId', 'deltaY']) },
  { name: 'browser_screenshot', description: 'Capture the visible viewport of a shared tab.', inputSchema: schema({ tabId: tab }, ['tabId']) },
];

async function ensureGateway() {
  try { if ((await callChrome('__ping', {})).result?.ok) return; } catch {}
  const child = spawn(process.execPath, [path.join(__dirname, 'gateway.cjs')], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { if ((await callChrome('__ping', {})).result?.ok) return; } catch {}
  }
  throw new Error('Local bridge gateway did not start');
}

function callChrome(method, params) {
  return new Promise((resolve, reject) => {
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch (error) { reject(error); return; }
    if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || typeof state.token !== 'string') { reject(new Error('Invalid bridge endpoint')); return; }
    const socket = net.createConnection({ host: '127.0.0.1', port: state.port });
    let input = Buffer.alloc(0);
    socket.setTimeout(35000, () => socket.destroy(new Error('Chrome did not respond')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ token: state.token, method, params }) + '\n'));
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_MESSAGE) { socket.destroy(new Error('Response too large')); return; }
      const newline = input.indexOf(10);
      if (newline < 0) return;
      try { resolve(JSON.parse(input.subarray(0, newline).toString('utf8'))); }
      catch (error) { reject(error); }
      socket.end();
    });
    socket.on('end', () => { if (!input.includes(10)) reject(new Error('Bridge disconnected')); });
  });
}

function mcp() {
  readline.createInterface({ input: process.stdin }).on('line', async line => {
    if (Buffer.byteLength(line) > MAX_MESSAGE) return;
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (!request || typeof request !== 'object' || Array.isArray(request) || !Object.hasOwn(request, 'id')) return;
    let response;
    if (request.method === 'initialize') {
      const offered = request.params?.protocolVersion;
      const protocolVersion = ['2024-11-05', '2025-03-26', '2025-06-18'].includes(offered) ? offered : '2025-06-18';
      response = { result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'agy-chrome-bridge', version: require('../extension/manifest.json').version } } };
    } else if (request.method === 'ping') response = { result: {} };
    else if (request.method === 'tools/list') response = { result: { tools } };
    else if (request.method === 'tools/call') {
      const name = request.params?.name;
      if (!tools.some(tool => tool.name === name)) response = { error: { code: -32602, message: 'Unknown tool' } };
      else {
        try {
          await ensureGateway();
          const reply = await callChrome(name, request.params.arguments || {});
          if (reply.error) response = { result: { isError: true, content: [{ type: 'text', text: String(reply.error) }] } };
          else if (name === 'browser_screenshot') response = { result: { content: [{ type: 'image', data: reply.result.data, mimeType: 'image/jpeg' }] } };
          else response = { result: { content: [{ type: 'text', text: JSON.stringify(reply.result) }] } };
        } catch (error) {
          response = { result: { isError: true, content: [{ type: 'text', text: `Chrome bridge unavailable: ${error.message}. Open the extension in the selected Chrome profile.` }] } };
        }
      }
    } else response = { error: { code: -32601, message: 'Method not found' } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\n');
  });
}

if (process.argv.includes('--shutdown')) callChrome('__shutdown', {}).then(() => process.exit(0), error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
else if (process.argv.includes('--mcp')) { ensureGateway().catch(() => {}); mcp(); }
else { process.stderr.write('Use --mcp or --shutdown\n'); process.exit(1); }
