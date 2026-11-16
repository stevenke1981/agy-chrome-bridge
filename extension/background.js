const COMMAND_TIMEOUT_MS = 15000;
const OPERATION_TIMEOUT_MS = 25000;
const NAVIGATION_TIMEOUT_MS = 20000;
const RECONNECT_DELAY_MS = 5000;
const RECONNECT_ALARM = 'reconnect';
const RECONNECT_ALARM_MINUTES = 0.5;
const PROFILE_MISMATCH_CLOSE_CODE = 4001;
const PROFILE_MISMATCH_STATUS = 'This Chrome profile is not the paired one. Run: node "%LOCALAPPDATA%\\agy-chrome-bridge\\bridge\\bridge.cjs" --unpair';
const DEFAULT_CLOSE_STATUS = 'AGY is not running or local connection is blocked';
const NOT_SHARED_MESSAGE = 'Tab is not shared. Open the extension in that tab and select Share this tab.';
const MAX_SCREENSHOT_LENGTH = 800000;
const MODIFIER_FLAGS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const SPECIAL_KEYS = { Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], ' ': ['Space', 32] };
const SNAPSHOT_EXPRESSION = `(() => {
        const path = el => {
          const parts = [];
          for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
            if (node.id) {
              const id = '#' + CSS.escape(node.id);
              if (document.querySelectorAll(id).length === 1) { parts.unshift(id); break; }
            }
            let part = node.localName;
            if (node.parentElement) part += ':nth-child(' + (Array.prototype.indexOf.call(node.parentElement.children, node) + 1) + ')';
            parts.unshift(part);
          }
          return parts.join(' > ');
        };
        const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[contenteditable=true]')].filter(visible).slice(0, 150).map(el => ({selector:path(el),role:el.getAttribute('role') || el.tagName.toLowerCase(),label:(el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').slice(0,200),type:el.getAttribute('type')}));
        return {title:document.title,url:location.href,text:(document.body?.innerText || '').slice(0,30000),elements};
      })()`;

let socket;
let reconnectTimer;
let connecting = false;
let status = 'disconnected';
const tabQueues = new Map();

function isSocketActive() {
  return Boolean(socket) && socket.readyState < WebSocket.CLOSING;
}

function closeStatus(event, failure) {
  if (event?.code === PROFILE_MISMATCH_CLOSE_CODE) return PROFILE_MISMATCH_STATUS;
  return failure || DEFAULT_CLOSE_STATUS;
}

function scheduleReconnectAlarm() {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_ALARM_MINUTES });
}

function startBridge() {
  scheduleReconnectAlarm();
  connect();
}

async function connect() {
  if (connecting || isSocketActive()) return;
  connecting = true;
  clearTimeout(reconnectTimer);
  status = 'connecting';
  let config;
  let profileKey;
  try {
    const response = await fetch(chrome.runtime.getURL('bridge_config.json'));
    if (!response.ok) throw new Error('missing configuration');
    config = await response.json();
    if (typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('invalid configuration');
    ({ profileKey } = await chrome.storage.local.get('profileKey'));
  } catch {
    status = 'Install the bridge and load its installed extension folder';
    connecting = false;
    return;
  }
  if (typeof profileKey !== 'string' || !/^[a-f0-9]{64}$/.test(profileKey)) { status = 'Pair this Chrome profile in the popup'; connecting = false; return; }
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(config.token.match(/../g), hex => parseInt(hex, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sign = async value => [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const clientNonce = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const connection = new WebSocket('ws://127.0.0.1:38745/bridge');
  socket = connection;
  connecting = false;
  let serverVerified = false;
  let ready = false;
  let failure;
  connection.onopen = () => connection.send(JSON.stringify({ type: 'hello', nonce: clientNonce }));
  connection.onmessage = async event => {
    let message;
    try { message = JSON.parse(event.data); }
    catch { failure = 'Local bridge sent invalid data'; connection.close(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { failure = 'Local bridge sent invalid data'; connection.close(); return; }
    if (message.type === 'challenge') {
      if (typeof message.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(message.nonce) || message.proof !== await sign(`server:${clientNonce}:${message.nonce}:`)) {
        failure = 'Local bridge authentication failed';
        connection.close();
        return;
      }
      serverVerified = true;
      connection.send(JSON.stringify({ type: 'proof', profileKey, proof: await sign(`client:${clientNonce}:${message.nonce}:${profileKey}`) }));
      return;
    }
    if (message.type === 'ready' && serverVerified) { ready = true; status = 'connected'; return; }
    if (!ready) { failure = 'Local bridge authentication failed'; connection.close(); return; }
    try {
      const result = await run(message.method, message.params || {});
      if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ id: message.id, result }));
    } catch (error) {
      if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ id: message.id, error: String(error.message || error) }));
    }
  };
  connection.onclose = event => {
    clearInterval(heartbeat);
    if (socket !== connection) return;
    status = closeStatus(event, failure);
    socket = undefined;
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  };
  connection.onerror = () => { status = 'Local connection failed'; };
  const heartbeat = setInterval(() => {
    if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'ping' }));
  }, 20000);
}

function withTimeout(promise, ms, message) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function serializeForTab(tabId, task) {
  const previous = tabQueues.get(tabId) ?? Promise.resolve();
  const result = previous.then(task);
  const settled = result.then(() => {}, () => {});
  tabQueues.set(tabId, settled);
  settled.then(() => { if (tabQueues.get(tabId) === settled) tabQueues.delete(tabId); });
  return result;
}

function command(target, method, params) {
  return withTimeout(chrome.debugger.sendCommand(target, method, params), COMMAND_TIMEOUT_MS, `Chrome did not respond to ${method} in time.`);
}

async function evaluateInPage(target, expression) {
  const evaluated = await command(target, 'Runtime.evaluate', { expression, returnByValue: true });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  return evaluated.result.value;
}

async function readShares() {
  const { sharedTabs, sharedOrigins } = await chrome.storage.session.get({ sharedTabs: [], sharedOrigins: {} });
  return { sharedTabs, sharedOrigins };
}

async function listSharedTabs() {
  const { sharedTabs, sharedOrigins } = await readShares();
  const tabs = await Promise.all(sharedTabs.map(id => chrome.tabs.get(id).catch(() => null)));
  return tabs.filter(Boolean).map(({ id, title, url }) => ({ id, title, url, sharedOrigin: sharedOrigins[id] }));
}

// Returns the origin recorded at share time, or throws if the tab is not shared or has moved.
async function verifiedOrigin(tabId) {
  const { sharedTabs, sharedOrigins } = await readShares();
  const origin = Number.isInteger(tabId) ? sharedOrigins[tabId] : undefined;
  if (!Number.isInteger(tabId) || !sharedTabs.includes(tabId) || typeof origin !== 'string') throw new Error(NOT_SHARED_MESSAGE);
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//i.test(tab.url || '')) throw new Error('Only HTTP and HTTPS pages can be controlled.');
  const currentOrigin = new URL(tab.url).origin;
  if (currentOrigin !== origin) throw new Error(`Tab moved to ${currentOrigin}; share it again from the extension popup.`);
  return origin;
}

async function attachDebugger(target) {
  const attaching = chrome.debugger.attach(target, '1.3');
  try {
    await withTimeout(attaching, COMMAND_TIMEOUT_MS, 'Chrome did not attach the debugger in time.');
  } catch (error) {
    // If the attach completes late, release it so the tab is not left debugged.
    attaching.then(() => chrome.debugger.detach(target).catch(() => {}), () => {});
    throw error;
  }
}

async function withDebugger(tabId, task) {
  const target = { tabId };
  await attachDebugger(target);
  try {
    return await task(target);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function navigateAndWaitForLoad(target, url) {
  const completed = new Set();
  let loaderId;
  let finish;
  const loaded = new Promise(resolve => { finish = resolve; });
  const onEvent = (source, event, details) => {
    if (source.tabId !== target.tabId || event !== 'Page.lifecycleEvent' || details.name !== 'load') return;
    completed.add(details.loaderId);
    if (details.loaderId === loaderId) finish();
  };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    const navigation = await command(target, 'Page.navigate', { url: url.href });
    if (navigation.errorText) throw new Error(navigation.errorText);
    if (navigation.isDownload) throw new Error('The URL triggered a download rather than a page navigation.');
    loaderId = navigation.loaderId;
    if (loaderId && !completed.has(loaderId)) await withTimeout(loaded, NAVIGATION_TIMEOUT_MS, 'Navigation timed out');
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
  }
}

async function navigate(target, params, origin) {
  const url = new URL(params.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
  if (url.origin !== origin) throw new Error(`Navigation to ${url.origin} is outside the shared origin ${origin}; share it again from the extension popup.`);
  await command(target, 'Page.enable');
  await command(target, 'Page.setLifecycleEventsEnabled', { enabled: true });
  await navigateAndWaitForLoad(target, url);
  return { navigated: url.href };
}

async function captureScreenshot(target) {
  let image = await command(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 });
  if (image.data.length > MAX_SCREENSHOT_LENGTH) image = await command(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 25 });
  if (image.data.length > MAX_SCREENSHOT_LENGTH) throw new Error('Screenshot is too large; reduce the browser window size and retry.');
  return image;
}

function keyDescriptor(key) {
  if (typeof key === 'string' && /^[a-z]$/i.test(key)) return [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
  if (typeof key === 'string' && /^[0-9]$/.test(key)) return [`Digit${key}`, key.charCodeAt(0)];
  return Object.hasOwn(SPECIAL_KEYS, key) ? SPECIAL_KEYS[key] : undefined;
}

function isValidModifiers(modifiers) {
  return Array.isArray(modifiers) && modifiers.every(value => Object.hasOwn(MODIFIER_FLAGS, value)) && new Set(modifiers).size === modifiers.length;
}

function keyEvents(key, [code, virtualKeyCode], modifiers) {
  const shifted = modifiers.includes('Shift');
  const shiftedDigit = shifted && /^[0-9]$/.test(key) ? ')!@#$%^&*('[Number(key)] : undefined;
  const actualKey = shiftedDigit ?? (shifted && /^[a-z]$/i.test(key) ? key.toUpperCase() : key);
  const event = { key: actualKey, code, windowsVirtualKeyCode: virtualKeyCode, modifiers: modifiers.reduce((mask, value) => mask | MODIFIER_FLAGS[value], 0) };
  const blockedText = modifiers.some(value => ['Alt', 'Control', 'Meta'].includes(value));
  const text = blockedText ? undefined : key === 'Enter' ? '\r' : shiftedDigit ?? (key.length === 1 ? actualKey : undefined);
  const down = text === undefined ? { ...event, type: 'rawKeyDown' } : { ...event, type: 'keyDown', text, unmodifiedText: text };
  return { down, up: { ...event, type: 'keyUp' } };
}

async function pressKey(target, params) {
  const modifiers = params.modifiers ?? [];
  const descriptor = keyDescriptor(params.key);
  if (!descriptor || !isValidModifiers(modifiers)) throw new Error('Unsupported key or modifiers');
  const { down, up } = keyEvents(params.key, descriptor, modifiers);
  await command(target, 'Input.dispatchKeyEvent', down);
  await command(target, 'Input.dispatchKeyEvent', up);
  return { ok: true };
}

async function scrollPage(target, params) {
  const deltaX = params.deltaX ?? 0;
  const deltaY = params.deltaY;
  if (![deltaX, deltaY].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 3000)) throw new Error('Scroll distances must be finite numbers within 3000 pixels');
  const center = await evaluateInPage(target, '({x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2)})');
  await command(target, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...center, deltaX, deltaY });
  return { ok: true };
}

function actionExpression(method, selector) {
  return `(() => {
        const matches = document.querySelectorAll(${JSON.stringify(selector)});
        if (matches.length === 0) throw new Error('Element not found');
        if (matches.length !== 1) throw new Error('Selector matches multiple elements');
        const el = matches[0];
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) throw new Error('Element is not visible');
        el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (!hit || (hit !== el && !el.contains(hit))) throw new Error('Element is obstructed or outside the viewport');
        const editable = el.matches('input:not([type=hidden]),textarea,[contenteditable=true]');
        if (${method === 'browser_type'}) {
          if (!editable) throw new Error('An editable element is required');
          el.focus();
          if (document.activeElement !== el && !el.contains(document.activeElement)) throw new Error('Could not focus the requested element');
        }
        return {x, y, editable};
      })()`;
}

async function clickAt(target, { x, y }) {
  await command(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await command(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function elementAction(target, method, params) {
  if (typeof params.selector !== 'string' || params.selector.length > 2000) throw new Error('A CSS selector is required.');
  if (method === 'browser_type' && (typeof params.text !== 'string' || params.text.length > 20000)) throw new Error('Text is required.');
  const point = await evaluateInPage(target, actionExpression(method, params.selector));
  if (method === 'browser_click') await clickAt(target, point);
  else await command(target, 'Input.insertText', { text: params.text });
  return { ok: true };
}

function runBrowserOperation(target, method, params, origin) {
  switch (method) {
    case 'browser_navigate': return navigate(target, params, origin);
    case 'browser_screenshot': return captureScreenshot(target);
    case 'browser_key': return pressKey(target, params);
    case 'browser_scroll': return scrollPage(target, params);
    case 'browser_snapshot': return evaluateInPage(target, SNAPSHOT_EXPRESSION);
    case 'browser_click':
    case 'browser_type': return elementAction(target, method, params);
    default: throw new Error('Unknown browser operation');
  }
}

async function runOnSharedTab(method, params) {
  const origin = await verifiedOrigin(params.tabId);
  return withDebugger(params.tabId, target => runBrowserOperation(target, method, params, origin));
}

async function run(method, params) {
  if (method === 'browser_tabs') return listSharedTabs();
  const task = serializeForTab(params.tabId, () => runOnSharedTab(method, params));
  return withTimeout(task, OPERATION_TIMEOUT_MS, `Browser operation timed out after ${OPERATION_TIMEOUT_MS / 1000} s.`);
}

async function forgetTab(tabId) {
  const { sharedTabs, sharedOrigins } = await readShares();
  await chrome.storage.session.set({
    sharedTabs: sharedTabs.filter(id => id !== tabId),
    sharedOrigins: Object.fromEntries(Object.entries(sharedOrigins).filter(([id]) => Number(id) !== tabId)),
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'reconnect') connect();
  if (message.type === 'status' || message.type === 'reconnect') sendResponse({ status });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name === RECONNECT_ALARM && !isSocketActive()) connect();
});
chrome.runtime.onStartup.addListener(startBridge);
chrome.runtime.onInstalled.addListener(startBridge);
chrome.tabs.onRemoved.addListener(forgetTab);
startBridge();
