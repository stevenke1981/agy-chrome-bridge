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
    setAttribute() {},
    addEventListener(name, callback) { this.handlers[name] = callback; },
    async click() { await this.handlers.click(); },
  };
}

async function setup(tab, initial = {}) {
  const elements = Object.fromEntries(['version', 'status', 'pair', 'tab', 'toggle', 'reconnect', 'shared', 'unavailable', 'diagnose', 'diagnostic'].map(id => [id, element()]));
  const document = { querySelector: selector => elements[selector.slice(1)], createElement: element };
  const store = { sharedTabs: [], sharedOrigins: {}, ...initial };
  let profileKey;
  const messages = [];
  const chrome = {
    tabs: { query: async () => [tab], get: async id => ({ ...tab, id }) },
    runtime: { getManifest: () => manifest, sendMessage: async message => { messages.push(message.type); return { status: 'connected' }; } },
    storage: {
      session: {
        get: async defaults => Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, store[key] ?? fallback])),
        set: async values => { Object.assign(store, values); },
      },
      local: { get: async () => ({ profileKey }), set: async value => { profileKey = value.profileKey; } },
    },
  };
  const crypto = { getRandomValues: bytes => bytes.fill(7) };
  class FakeWebSocket { constructor(url) { this.url = url; setImmediate(() => this.onopen()); } close() {} }
  await new AsyncFunction('chrome', 'document', 'setInterval', 'crypto', 'WebSocket', source)(chrome, document, () => {}, crypto, FakeWebSocket);
  return { elements, shared: () => store.sharedTabs, origins: () => store.sharedOrigins, paired: () => profileKey, messages };
}

(async () => {
  const current = await setup({ id: 7, title: 'Example', url: 'https://example.com/' });
  assert.equal(current.elements.version.textContent, `Version ${manifest.version}`);
  assert.equal(current.elements.pair.hidden, false);
  await current.elements.pair.click();
  assert.equal(current.elements.pair.hidden, true);
  assert.match(current.paired(), /^[a-f0-9]{64}$/);
  assert.ok(current.messages.includes('reconnect'));
  assert.equal(current.elements.status.textContent, 'Bridge: connected');
  assert.equal(current.elements.shared.children[0].textContent, 'No tabs shared');
  assert.equal(current.elements.toggle.textContent, 'Share this tab');
  await current.elements.toggle.click();
  assert.deepEqual(current.shared(), [7]);
  assert.deepEqual(current.origins(), { 7: 'https://example.com' }, 'sharing records the tab origin');
  assert.equal(current.elements.toggle.textContent, 'Stop sharing this tab');
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
  console.log('Popup checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
