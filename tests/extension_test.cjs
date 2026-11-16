const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHmac, webcrypto } = require('node:crypto');

function event() {
  const callbacks = new Set();
  return { addListener: f => callbacks.add(f), removeListener: f => callbacks.delete(f), emit: (...args) => { for (const f of [...callbacks]) f(...args); } };
}
const updated = event();
const debuggerEvents = event();
let connection;
const opens = [];
const waitOpen = () => new Promise(resolve => opens.push(resolve));
let resolveProof;
class FakeWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; connection = this; setImmediate(() => { this.readyState = 1; this.onopen(); opens.shift()?.(this); }); }
  send(value) { const message = JSON.parse(value); this.sent.push(message); if (message.type === 'proof') resolveProof?.(message); }
  close() { this.readyState = 3; this.onclose(); }
}
let images = [];
let newPageLoaded = false;
let download = false;
let obstructed = false;
let mouseEvents = 0;
let duplicateFixture = false;
let editable = false;
let redirectFocus = false;
let typedText = [];
let keyEvents = [];
let scrollEvents = [];
const chrome = {
  runtime: { getURL: path => `chrome-extension://test/${path}`, onMessage: event(), onStartup: event(), onInstalled: event(), id: 'test' },
  storage: { session: { get: async () => ({ sharedTabs: [7] }), set: async () => {} }, local: { get: async () => ({ profileKey: 'c'.repeat(64) }) } },
  tabs: { get: async id => ({ id, url: 'https://example.com', title: 'Example' }), update: async (id, options) => {
    updated.emit(id, { status: 'complete' }, { url: 'https://old.example/' });
    setImmediate(() => { updated.emit(id, { status: 'loading', url: options.url }, { url: options.url }); updated.emit(id, { status: 'complete' }, { url: options.url }); });
    return { url: 'https://old.example/', status: 'loading' };
  }, onUpdated: updated, onRemoved: event() },
  debugger: { attach: async () => {}, detach: async () => {}, onEvent: debuggerEvents, sendCommand: async (target, method, params) => {
    if (method === 'Page.captureScreenshot') return { data: images.shift() };
    if (method === 'Input.dispatchMouseEvent') { if (params.type === 'mouseWheel') scrollEvents.push(params); else mouseEvents++; return {}; }
    if (method === 'Input.dispatchKeyEvent') { keyEvents.push(params); return {}; }
    if (method === 'Input.insertText') { typedText.push(params.text); return {}; }
    if (method === 'Runtime.evaluate') {
      const element = { getBoundingClientRect: () => ({ x: 10, y: 10, width: 40, height: 20 }), scrollIntoView() {}, focus() { document.activeElement = redirectFocus ? {} : element; }, matches: () => editable, contains: hit => hit === element };
      const document = { querySelector: () => element, querySelectorAll: selector => selector === '#duplicate' ? [element, element] : [element], elementFromPoint: () => obstructed ? {} : element };
      if (duplicateFixture) {
        const html = { nodeType: 1, localName: 'html', parentElement: null };
        const body = { nodeType: 1, localName: 'body', parentElement: html };
        html.children = [body];
        const button = text => ({ nodeType: 1, id: 'duplicate', localName: 'button', tagName: 'BUTTON', parentElement: body, offsetWidth: 10, offsetHeight: 10, innerText: text, getAttribute: () => null });
        const buttons = [button('Delete'), button('Save')];
        body.children = buttons;
        document.body = { innerText: 'Delete Save' };
        document.title = 'Duplicate identifiers';
        document.querySelectorAll = selector => selector === '#duplicate' || selector.startsWith('a,button,') ? buttons : [];
      }
      try { return { result: { value: vm.runInNewContext(params.expression, { document, CSS: { escape: x => x }, location: { href: 'https://example.com' }, window: { innerWidth: 800, innerHeight: 600 } }) } }; }
      catch (error) { return { exceptionDetails: { text: error.message } }; }
    }
    if (method === 'Page.navigate') {
      if (download) return { isDownload: true };
      debuggerEvents.emit(target, 'Page.lifecycleEvent', { name: 'load', loaderId: 'old' });
      setImmediate(() => { newPageLoaded = true; debuggerEvents.emit(target, 'Page.lifecycleEvent', { name: 'load', loaderId: 'new' }); });
      return { loaderId: 'new' };
    }
    return {};
  } },
};
const firstOpen = waitOpen();
const context = vm.createContext({ chrome, URL, WebSocket: FakeWebSocket, crypto: webcrypto, TextEncoder, fetch: async () => ({ ok: true, json: async () => ({ token: 'a'.repeat(64) }) }), setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout, setInterval: () => 1, clearInterval: () => {}, console });
vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
const run = (method, params) => vm.runInContext('run', context)(method, params);
(async () => {
  let reported;
  await firstOpen;
  chrome.runtime.onMessage.emit({ type: 'status' }, { id: 'test' }, result => { reported = result.status; });
  assert.equal(reported, 'connecting');
  assert.equal(connection.url, 'ws://127.0.0.1:38745/bridge');
  assert.equal(connection.sent[0].type, 'hello');
  assert.equal('token' in connection.sent[0], false, 'never send the secret to an unverified server');
  connection.onmessage({ data: JSON.stringify({ id: 'fake', method: 'browser_tabs' }) });
  assert.equal(connection.readyState, 3, 'commands before authentication must be rejected');
  assert.equal(connection.sent.length, 1);
  const secondOpen = waitOpen();
  chrome.runtime.onMessage.emit({ type: 'reconnect' }, { id: 'test' }, () => {});
  await secondOpen;
  await connection.onmessage({ data: JSON.stringify({ type: 'challenge', nonce: 'b'.repeat(64), proof: '0'.repeat(64) }) });
  assert.equal(connection.readyState, 3, 'an unverified server must not complete authentication');
  assert.equal(connection.sent.length, 1, 'the pairing secret and profile key stay private');
  const thirdOpen = waitOpen();
  chrome.runtime.onMessage.emit({ type: 'reconnect' }, { id: 'test' }, () => {});
  await thirdOpen;
  const nonce = 'b'.repeat(64);
  const hello = connection.sent[0];
  const proof = createHmac('sha256', Buffer.from('a'.repeat(64), 'hex')).update(`server:${hello.nonce}:${nonce}:`).digest('hex');
  const clientProof = new Promise(resolve => { resolveProof = resolve; });
  connection.onmessage({ data: JSON.stringify({ type: 'challenge', nonce, proof }) });
  const response = await clientProof;
  assert.equal(response.profileKey, 'c'.repeat(64));
  connection.onmessage({ data: JSON.stringify({ type: 'ready' }) });
  chrome.runtime.onMessage.emit({ type: 'status' }, { id: 'test' }, result => { reported = result.status; });
  assert.equal(reported, 'connected');
  connection.onmessage({ data: 'null' });
  assert.equal(connection.readyState, 3, 'invalid server messages must close the connection');
  chrome.runtime.onMessage.emit({ type: 'status' }, { id: 'test' }, result => { reported = result.status; });
  assert.equal(reported, 'Local bridge sent invalid data');
  assert.equal((await run('browser_tabs', {}))[0].id, 7);
  await assert.rejects(() => run('browser_snapshot', { tabId: 8 }), /not shared/);
  await assert.rejects(() => run('browser_navigate', { tabId: 7, url: 'file:///secret' }), /HTTP and HTTPS/);
  assert.equal((await run('browser_navigate', { tabId: 7, url: 'https://example.org/' })).navigated, 'https://example.org/');
  assert.equal(newPageLoaded, true);
  duplicateFixture = true;
  const snapshot = await run('browser_snapshot', { tabId: 7 });
  assert.notEqual(snapshot.elements[0].selector, snapshot.elements[1].selector, 'duplicate IDs need distinct selectors');
  duplicateFixture = false;
  await assert.rejects(() => run('browser_click', { tabId: 7, selector: '#duplicate' }), /multiple elements/);
  assert.equal(mouseEvents, 0, 'an ambiguous selector must not receive a mouse event');
  obstructed = true;
  await assert.rejects(() => run('browser_click', { tabId: 7, selector: '#target' }), /obstructed/);
  assert.equal(mouseEvents, 0, 'a covered element must not receive a mouse event');
  obstructed = false;
  await run('browser_click', { tabId: 7, selector: '#target' });
  assert.equal(mouseEvents, 2, 'an unobstructed element receives a complete click');
  editable = true;
  redirectFocus = true;
  await assert.rejects(() => run('browser_type', { tabId: 7, selector: '#target', text: 'test' }), /focus/);
  assert.deepEqual(typedText, []);
  redirectFocus = false;
  await run('browser_type', { tabId: 7, selector: '#target', text: 'test' });
  assert.deepEqual(typedText, ['test']);
  await run('browser_key', { tabId: 7, key: 'a', modifiers: ['Control'] });
  assert.equal(keyEvents.length, 2);
  assert.equal(keyEvents[0].modifiers, 2);
  assert.equal(keyEvents[0].windowsVirtualKeyCode, 65);
  await assert.rejects(() => run('browser_key', { tabId: 7, key: '__proto__' }), /Unsupported/);
  await assert.rejects(() => run('browser_key', { tabId: 7, key: 'Enter', modifiers: ['Invalid'] }), /Unsupported/);
  assert.equal(keyEvents.length, 2);
  await run('browser_key', { tabId: 7, key: 'Enter' });
  assert.equal(keyEvents[2].type, 'keyDown');
  assert.equal(keyEvents[2].text, '\r');
  await run('browser_key', { tabId: 7, key: 'a', modifiers: ['Shift'] });
  assert.equal(keyEvents[4].text, 'A');
  await run('browser_key', { tabId: 7, key: '1', modifiers: ['Shift'] });
  assert.equal(keyEvents[6].key, '!');
  assert.equal(keyEvents[6].text, '!');
  await run('browser_scroll', { tabId: 7, deltaY: 400 });
  assert.equal(scrollEvents[0].deltaY, 400);
  assert.equal(scrollEvents[0].x, 400);
  await assert.rejects(() => run('browser_scroll', { tabId: 7, deltaY: 4000 }), /Scroll distances/);
  download = true;
  await assert.rejects(() => run('browser_navigate', { tabId: 7, url: 'https://example.org/file.zip' }), /download/);
  download = false;
  images = ['x'.repeat(800001), 'y'.repeat(800001)];
  await assert.rejects(() => run('browser_screenshot', { tabId: 7 }), /too large/);
  images = ['x'.repeat(800001), 'small'];
  assert.equal((await run('browser_screenshot', { tabId: 7 })).data, 'small');
  console.log('Extension checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
