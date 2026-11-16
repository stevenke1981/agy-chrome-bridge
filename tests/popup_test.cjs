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

async function setup(tab) {
  const elements = Object.fromEntries(['version', 'status', 'tab', 'toggle', 'reconnect', 'shared', 'unavailable', 'diagnose', 'diagnostic'].map(id => [id, element()]));
  const document = { querySelector: selector => elements[selector.slice(1)], createElement: element };
  let sharedTabs = [];
  const chrome = {
    tabs: { query: async () => [tab], get: async id => ({ ...tab, id }) },
    runtime: { getManifest: () => manifest, sendMessage: async () => ({ status: 'connected' }) },
    storage: { session: { get: async () => ({ sharedTabs }), set: async value => { sharedTabs = value.sharedTabs; } } },
  };
  await new AsyncFunction('chrome', 'document', 'setInterval', source)(chrome, document, () => {});
  return { elements, shared: () => sharedTabs };
}

(async () => {
  const current = await setup({ id: 7, title: 'Example', url: 'https://example.com/' });
  assert.equal(current.elements.version.textContent, `Version ${manifest.version}`);
  assert.equal(current.elements.status.textContent, 'Bridge: connected');
  assert.equal(current.elements.shared.children[0].textContent, 'No tabs shared');
  await current.elements.toggle.click();
  assert.deepEqual(current.shared(), [7]);
  assert.equal(current.elements.toggle.textContent, 'Stop sharing this tab');
  assert.equal(current.elements.shared.children[0].children[0].textContent, 'Example');
  await current.elements.shared.children[0].children[1].click();
  assert.deepEqual(current.shared(), []);
  const internal = await setup({ id: 8, title: 'New tab', url: 'chrome://newtab/' });
  assert.equal(internal.elements.toggle.disabled, true);
  assert.equal(internal.elements.unavailable.hidden, false);
  console.log('Popup checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
