const assert = require('node:assert/strict');
const fs = require('node:fs');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const source = fs.readFileSync('extension/popup.js', 'utf8');
const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));

function element() {
  return {
    textContent: '', children: [], hidden: false, disabled: false, handlers: {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.handlers[name] = callback; },
    async click() { await this.handlers.click(); },
  };
}

async function setup(tab, initial = {}, bridgeStatus = 'connected', local = { autoShare: false }) {
  const elements = Object.fromEntries(['version', 'status', 'pill', 'detail', 'origin', 'tab', 'toggle', 'reconnect', 'shared', 'unavailable', 'autoShare'].map(id => [id, element()]));
  const document = { querySelector: selector => elements[selector.slice(1)], createElement: element };
  const store = { sharedTabs: [], sharedOrigins: {}, ...initial };
  const messages = [];
  const chrome = {
    tabs: { query: async () => [tab], get: async id => ({ ...tab, id }) },
    runtime: { getManifest: () => manifest, sendMessage: async message => { messages.push(message.type); return { status: bridgeStatus }; } },
    storage: {
      session: {
        get: async defaults => Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, store[key] ?? fallback])),
        set: async values => { Object.assign(store, values); },
      },
      local: { get: async () => ({ ...local }), set: async values => { Object.assign(local, values); } },
    },
  };
  const crypto = { getRandomValues: bytes => bytes.fill(7) };
  class FakeWebSocket { constructor(url) { this.url = url; setImmediate(() => this.onopen()); } close() {} }
  await new AsyncFunction('chrome', 'document', 'setInterval', 'crypto', 'WebSocket', source)(chrome, document, () => {}, crypto, FakeWebSocket);
  return { elements, shared: () => store.sharedTabs, origins: () => store.sharedOrigins, messages, local };
}

(async () => {
  const current = await setup({ id: 7, title: 'Example', url: 'https://example.com/' });
  assert.equal(current.elements.version.textContent, `Version ${manifest.version}`);
  assert.equal(current.elements.status.textContent, 'Connected to AGY');
  assert.equal(current.elements.pill.attributes['data-state'], 'ok');
  assert.equal(current.elements.detail.hidden, true);
  assert.equal(current.elements.origin.textContent, 'example.com');
  assert.equal(current.messages.includes('reconnect'), false, 'opening the popup needs no pairing step');
  await current.elements.reconnect.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(current.messages.includes('reconnect'), 'Reconnect asks the background to connect');
  assert.equal(current.elements.shared.children[0].textContent, 'No tabs shared');
  assert.equal(current.elements.toggle.textContent, 'Share this tab');
  await current.elements.toggle.click();
  assert.deepEqual(current.shared(), [7]);
  assert.deepEqual(current.origins(), { 7: 'https://example.com' }, 'sharing records the tab origin');
  assert.equal(current.elements.toggle.textContent, 'Stop sharing this tab');
  assert.equal(current.elements.toggle.attributes['data-shared'], 'true');
  assert.equal(current.elements.shared.children[0].children[0].textContent, 'Example');
  await current.elements.shared.children[0].children[1].click();
  assert.deepEqual(current.shared(), []);
  assert.deepEqual(current.origins(), {}, 'stopping removes the recorded origin');

  const moved = await setup({ id: 7, title: 'Example', url: 'https://example.com/' }, { sharedTabs: [7], sharedOrigins: { 7: 'https://old.example' } });
  assert.equal(moved.elements.toggle.textContent, 'Share this tab again', 'a tab shared from another origin must be shared again');
  await moved.elements.toggle.click();
  assert.deepEqual(moved.origins(), { 7: 'https://example.com' }, 're-sharing updates the recorded origin');
  assert.deepEqual(moved.shared(), [7]);
  assert.equal(moved.elements.toggle.textContent, 'Stop sharing this tab');

  const internal = await setup({ id: 8, title: 'New tab', url: 'chrome://newtab/' });
  assert.equal(internal.elements.toggle.disabled, true);
  assert.equal(internal.elements.unavailable.hidden, false);
  const waiting = await setup({ id: 9, title: 'Example', url: 'https://example.com/' }, {}, 'AGY is not running or local connection is blocked');
  assert.equal(waiting.elements.status.textContent, 'Waiting for AGY');
  assert.equal(waiting.elements.pill.attributes['data-state'], 'busy');
  assert.equal(waiting.elements.detail.hidden, false);

  const mismatch = 'Another Chrome profile is already paired. To use this one, run: node x --unpair';
  const refused = await setup({ id: 9, title: 'Example', url: 'https://example.com/' }, {}, mismatch);
  assert.equal(refused.elements.status.textContent, 'Not connected');
  assert.equal(refused.elements.pill.attributes['data-state'], 'bad');
  assert.equal(refused.elements.detail.textContent, mismatch, 'errors show the background detail');
  const starting = await setup({ id: 9, title: 'Example', url: 'https://example.com/' }, {}, 'connecting');
  assert.equal(starting.elements.status.textContent, 'Connecting…');
  assert.equal(starting.elements.pill.attributes['data-state'], 'busy');
  const missing = await setup({ id: 9, title: 'Example', url: 'https://example.com/' }, {}, 'Install the bridge and load its installed extension folder');
  assert.equal(missing.elements.pill.attributes['data-state'], 'bad');
  assert.equal(missing.elements.detail.textContent, 'Install the bridge and load its installed extension folder');
  const automatic = await setup({ id: 7, title: 'Example', url: 'https://example.com/' }, {}, 'connected', {});
  assert.equal(automatic.elements.autoShare.checked, true, 'auto-share is on by default');
  assert.equal(automatic.elements.toggle.hidden, true, 'no per-tab share button while auto-share is on');
  assert.equal(automatic.elements.shared.children[0].textContent, 'All HTTP(S) tabs, including this one');
  automatic.elements.autoShare.checked = false;
  await automatic.elements.autoShare.handlers.change();
  assert.equal(automatic.local.autoShare, false, 'turning the switch off is stored');
  assert.equal(automatic.elements.toggle.hidden, false);
  assert.equal(automatic.elements.shared.children[0].textContent, 'No tabs shared');
  console.log('Popup checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
