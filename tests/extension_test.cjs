const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHmac, webcrypto } = require('node:crypto');

const PROFILE_MISMATCH_TEXT = String.raw`This Chrome profile is not the paired one. Run: node "%LOCALAPPDATA%\agy-chrome-bridge\bridge\bridge.cjs" --unpair`;
const DEFAULT_CLOSE_TEXT = 'AGY is not running or local connection is blocked';
const COMMAND_MS = 15000;
const OPERATION_MS = 25000;
const tick = () => new Promise(resolve => setImmediate(resolve));

function event() {
  const callbacks = new Set();
  return { addListener: f => callbacks.add(f), removeListener: f => callbacks.delete(f), emit: (...args) => { for (const f of [...callbacks]) f(...args); } };
}

const debuggerEvents = event();
const alarmEvents = event();
const alarms = [];
const delays = { command: COMMAND_MS, operation: OPERATION_MS };
let connection;
let socketCount = 0;
const opens = [];
const waitOpen = () => new Promise(resolve => opens.push(resolve));
let resolveProof;
class FakeWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; connection = this; socketCount++; setImmediate(() => { this.readyState = 1; this.onopen(); opens.shift()?.(this); }); }
  send(value) { const message = JSON.parse(value); this.sent.push(message); if (message.type === 'proof') resolveProof?.(message); }
  close() { this.readyState = 3; this.onclose(); }
}

let sessionStore = { sharedTabs: [7], sharedOrigins: { 7: 'https://example.com' } };
let tabUrl = 'https://example.com/';
const attached = new Set();
let attachCount = 0;
let detachCount = 0;
let hangMethod;
let slowMethod;
let slowMs = 0;
let navigateCalls = 0;
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
let scrolledWith = [];

function readSession(defaults) {
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, sessionStore[key] ?? fallback]));
}

async function fakeCommand(target, method, params) {
  if (method === 'Page.captureScreenshot') return { data: images.shift() };
  if (method === 'Input.dispatchMouseEvent') { if (params.type === 'mouseWheel') scrollEvents.push(params); else mouseEvents++; return {}; }
  if (method === 'Input.dispatchKeyEvent') { keyEvents.push(params); return {}; }
  if (method === 'Input.insertText') { typedText.push(params.text); return {}; }
  if (method === 'Runtime.evaluate') return evaluate(params);
  if (method === 'Page.navigate') return navigate(target);
  return {};
}

function evaluate(params) {
  const element = {
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 40, height: 20 }),
    scrollIntoView(options) { scrolledWith.push(options); },
    focus() { document.activeElement = redirectFocus ? {} : element; },
    matches: () => editable,
    contains: hit => hit === element,
  };
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
  try {
    return { result: { value: vm.runInNewContext(params.expression, { document, CSS: { escape: x => x }, location: { href: 'https://example.com' }, window: { innerWidth: 800, innerHeight: 600 } }) } };
  } catch (error) {
    return { exceptionDetails: { text: error.message } };
  }
}

function navigate(target) {
  navigateCalls++;
  if (download) return { isDownload: true };
  debuggerEvents.emit(target, 'Page.lifecycleEvent', { name: 'load', loaderId: 'old' });
  setImmediate(() => { newPageLoaded = true; debuggerEvents.emit(target, 'Page.lifecycleEvent', { name: 'load', loaderId: 'new' }); });
  return { loaderId: 'new' };
}

const chrome = {
  runtime: { getURL: path => `chrome-extension://test/${path}`, onMessage: event(), onStartup: event(), onInstalled: event(), id: 'test' },
  alarms: { create: (name, info) => alarms.push({ name, info }), onAlarm: alarmEvents },
  storage: {
    session: { get: async defaults => readSession(defaults), set: async values => { Object.assign(sessionStore, values); } },
    local: { get: async () => ({ profileKey: 'c'.repeat(64) }) },
  },
  tabs: { get: async id => ({ id, url: tabUrl, title: 'Example' }), onRemoved: event() },
  debugger: {
    attach: async target => {
      if (attached.has(target.tabId)) throw new Error('Another debugger is already attached');
      attached.add(target.tabId);
      attachCount++;
    },
    detach: async target => { attached.delete(target.tabId); detachCount++; },
    onEvent: debuggerEvents,
    sendCommand: async (target, method, params) => {
      if (method === hangMethod) return new Promise(() => {});
      if (method === slowMethod) await new Promise(resolve => setTimeout(resolve, slowMs));
      return fakeCommand(target, method, params);
    },
  },
};

const delayedTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms === COMMAND_MS ? delays.command : ms === OPERATION_MS ? delays.operation : ms);
  timer.unref();
  return timer;
};

const firstOpen = waitOpen();
const context = vm.createContext({ chrome, URL, WebSocket: FakeWebSocket, crypto: webcrypto, TextEncoder, fetch: async () => ({ ok: true, json: async () => ({ token: 'a'.repeat(64) }) }), setTimeout: delayedTimer, clearTimeout, setInterval: () => 1, clearInterval: () => {}, console });
vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
const run = (method, params) => vm.runInContext('run', context)(method, params);

const currentStatus = () => {
  let value;
  chrome.runtime.onMessage.emit({ type: 'status' }, { id: 'test' }, result => { value = result.status; });
  return value;
};

// Shimmed timers are unref'd so the worker's own timers do not keep the test alive; hold the loop open explicitly.
const keepAlive = setInterval(() => {}, 1000);
let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('Extension checks did not complete'); process.exitCode = 1; }
});

(async () => {
  await firstOpen;
  assert.deepEqual(JSON.parse(JSON.stringify(alarms)), [{ name: 'reconnect', info: { periodInMinutes: 0.5 } }], 'the reconnect alarm is created at worker start');
  chrome.runtime.onStartup.emit();
  chrome.runtime.onInstalled.emit();
  assert.equal(alarms.length, 3, 'startup and install refresh the reconnect alarm');
  assert.equal(currentStatus(), 'connecting');
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
  assert.equal(currentStatus(), 'connected');
  connection.onmessage({ data: 'null' });
  assert.equal(connection.readyState, 3, 'invalid server messages must close the connection');
  assert.equal(currentStatus(), 'Local bridge sent invalid data');

  const [listed] = await run('browser_tabs', {});
  assert.equal(listed.id, 7);
  assert.equal(listed.sharedOrigin, 'https://example.com', 'browser_tabs reports the origin recorded at share time');
  await assert.rejects(() => run('browser_snapshot', { tabId: 8 }), /not shared/);
  await assert.rejects(() => run('browser_navigate', { tabId: 7, url: 'file:///secret' }), /HTTP and HTTPS/);
  await assert.rejects(() => run('browser_navigate', { tabId: 7, url: 'https://example.org/' }), /outside the shared origin https:\/\/example\.com/);
  assert.equal(navigateCalls, 0, 'a cross-origin URL never reaches the page');
  assert.equal((await run('browser_navigate', { tabId: 7, url: 'https://example.com/next' })).navigated, 'https://example.com/next');
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
  assert.deepEqual(JSON.parse(JSON.stringify(scrolledWith.at(-1))), { block: 'center', inline: 'center', behavior: 'instant' }, 'elements are centred before the hit test');
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
  await assert.rejects(() => run('browser_navigate', { tabId: 7, url: 'https://example.com/file.zip' }), /download/);
  download = false;
  images = ['x'.repeat(800001), 'y'.repeat(800001)];
  await assert.rejects(() => run('browser_screenshot', { tabId: 7 }), /too large/);
  images = ['x'.repeat(800001), 'small'];
  assert.equal((await run('browser_screenshot', { tabId: 7 })).data, 'small');

  // Concurrent operations on one tab are serialized: both attach in turn instead of failing.
  duplicateFixture = true;
  const attachesBefore = attachCount;
  const pair = await Promise.all([run('browser_snapshot', { tabId: 7 }), run('browser_snapshot', { tabId: 7 })]);
  duplicateFixture = false;
  assert.ok(pair.every(result => result.elements.length === 2), 'both concurrent snapshots succeed');
  assert.equal(attachCount - attachesBefore, 2);
  assert.equal(attached.size, 0);

  // A hung command times out and the debugger is still detached.
  delays.command = 20;
  hangMethod = 'Runtime.evaluate';
  const detachesBefore = detachCount;
  await assert.rejects(() => run('browser_scroll', { tabId: 7, deltaY: 10 }), /did not respond/);
  hangMethod = undefined;
  delays.command = COMMAND_MS;
  assert.equal(attached.size, 0, 'a timed-out command detaches the debugger');
  assert.equal(detachCount - detachesBefore, 1);

  // A slow operation exceeds the operation budget; it reports a timeout and detaches after its last command.
  delays.operation = 20;
  slowMethod = 'Runtime.evaluate';
  slowMs = 60;
  await assert.rejects(() => run('browser_scroll', { tabId: 7, deltaY: 10 }), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 150));
  slowMethod = undefined;
  slowMs = 0;
  delays.operation = OPERATION_MS;
  assert.equal(attached.size, 0, 'a timed-out operation still detaches');

  // Origin lock: a tab that moved is refused before attaching; re-sharing records the new origin.
  const attachesBeforeMove = attachCount;
  tabUrl = 'https://other.example/';
  await assert.rejects(() => run('browser_snapshot', { tabId: 7 }), error => error.message === 'Tab moved to https://other.example; share it again from the extension popup.');
  assert.equal(attachCount, attachesBeforeMove, 'a moved tab is not attached');
  const [moved] = await run('browser_tabs', {});
  assert.equal(moved.sharedOrigin, 'https://example.com');
  await chrome.storage.session.set({ sharedOrigins: { 7: 'https://other.example' } });
  assert.equal((await run('browser_scroll', { tabId: 7, deltaY: 10 })).ok, true, 're-sharing updates the recorded origin');
  await chrome.storage.session.set({ sharedOrigins: { 7: 'https://example.com' } });
  tabUrl = 'https://example.com/';

  // Reconnect alarm and close codes.
  const socketsBefore = socketCount;
  alarmEvents.emit({ name: 'unrelated' });
  await tick();
  assert.equal(socketCount, socketsBefore, 'other alarms do not reconnect');
  const reopened = waitOpen();
  alarmEvents.emit({ name: 'reconnect' });
  await reopened;
  assert.equal(socketCount, socketsBefore + 1, 'the reconnect alarm opens a socket when none is active');
  connection.onclose({ code: 4001, reason: 'profile-mismatch' });
  assert.equal(currentStatus(), PROFILE_MISMATCH_TEXT, 'a pairing mismatch shows the unpair instruction');
  const reopenedAgain = waitOpen();
  alarmEvents.emit({ name: 'reconnect' });
  await reopenedAgain;
  connection.onclose({ code: 1008, reason: 'bad' });
  assert.equal(currentStatus(), DEFAULT_CLOSE_TEXT, 'other close codes keep the generic status');
  const finalOpen = waitOpen();
  alarmEvents.emit({ name: 'reconnect' });
  await finalOpen;
  alarmEvents.emit({ name: 'reconnect' });
  await tick();
  assert.equal(socketCount, socketsBefore + 3, 'the alarm does not replace an open socket');
  finished = true;
  clearInterval(keepAlive);
  console.log('Extension checks passed');
})().catch(error => { finished = true; clearInterval(keepAlive); console.error(error); process.exitCode = 1; });
