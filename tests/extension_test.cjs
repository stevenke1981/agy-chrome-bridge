const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function event() {
  const callbacks = new Set();
  return { addListener: f => callbacks.add(f), removeListener: f => callbacks.delete(f), emit: (...args) => { for (const f of [...callbacks]) f(...args); } };
}
const updated = event();
const debuggerEvents = event();
let images = [];
let newPageLoaded = false;
let download = false;
const chrome = {
  runtime: { connectNative: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {} }), onMessage: event(), onStartup: event(), onInstalled: event(), id: 'test' },
  storage: { session: { get: async () => ({ sharedTabs: [7] }), set: async () => {} } },
  tabs: { get: async id => ({ id, url: 'https://example.com', title: 'Example' }), update: async (id, options) => {
    updated.emit(id, { status: 'complete' }, { url: 'https://old.example/' });
    setImmediate(() => { updated.emit(id, { status: 'loading', url: options.url }, { url: options.url }); updated.emit(id, { status: 'complete' }, { url: options.url }); });
    return { url: 'https://old.example/', status: 'loading' };
  }, onUpdated: updated, onRemoved: event() },
  debugger: { attach: async () => {}, detach: async () => {}, onEvent: debuggerEvents, sendCommand: async (target, method) => {
    if (method === 'Page.captureScreenshot') return { data: images.shift() };
    if (method === 'Page.navigate') {
      if (download) return { isDownload: true };
      debuggerEvents.emit(target, 'Page.lifecycleEvent', { name: 'load', loaderId: 'old' });
      setImmediate(() => { newPageLoaded = true; debuggerEvents.emit(target, 'Page.lifecycleEvent', { name: 'load', loaderId: 'new' }); });
      return { loaderId: 'new' };
    }
    return {};
  } },
};
const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout, console });
vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
const run = (method, params) => vm.runInContext('run', context)(method, params);
(async () => {
  assert.equal((await run('browser_tabs', {}))[0].id, 7);
  await assert.rejects(() => run('browser_snapshot', { tabId: 8 }), /not shared/);
  await assert.rejects(() => run('browser_navigate', { tabId: 7, url: 'file:///secret' }), /HTTP and HTTPS/);
  assert.equal((await run('browser_navigate', { tabId: 7, url: 'https://example.org/' })).navigated, 'https://example.org/');
  assert.equal(newPageLoaded, true);
  download = true;
  await assert.rejects(() => run('browser_navigate', { tabId: 7, url: 'https://example.org/file.zip' }), /download/);
  download = false;
  images = ['x'.repeat(800001), 'y'.repeat(800001)];
  await assert.rejects(() => run('browser_screenshot', { tabId: 7 }), /too large/);
  images = ['x'.repeat(800001), 'small'];
  assert.equal((await run('browser_screenshot', { tabId: 7 })).data, 'small');
  console.log('Extension checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
