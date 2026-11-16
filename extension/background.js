const hostName = 'com.agy_chrome_bridge';
let port;
let status = 'disconnected';

function connect() {
  if (port) return;
  status = 'connecting';
  port = chrome.runtime.connectNative(hostName);
  port.onMessage.addListener(async (message) => {
    if (message.type === 'ready') { status = 'connected'; return; }
    try {
      const result = await run(message.method, message.params || {});
      port?.postMessage({ id: message.id, result });
    } catch (error) {
      port?.postMessage({ id: message.id, error: String(error.message || error) });
    }
  });
  port.onDisconnect.addListener(() => {
    status = chrome.runtime.lastError?.message || 'disconnected';
    port = undefined;
  });
}

async function sharedTabs() {
  return (await chrome.storage.session.get({ sharedTabs: [] })).sharedTabs;
}

async function run(method, params) {
  const shared = await sharedTabs();
  if (method === 'browser_tabs') {
    const tabs = await Promise.all(shared.map(id => chrome.tabs.get(id).catch(() => null)));
    return tabs.filter(Boolean).map(({ id, title, url }) => ({ id, title, url }));
  }
  if (!Number.isInteger(params.tabId) || !shared.includes(params.tabId)) throw new Error('Tab is not shared. Open the extension in that tab and select Share this tab.');
  const tab = await chrome.tabs.get(params.tabId);
  if (!/^https?:\/\//i.test(tab.url || '')) throw new Error('Only HTTP and HTTPS pages can be controlled.');
  const target = { tabId: params.tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    if (method === 'browser_navigate') {
      const url = new URL(params.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
      await chrome.debugger.sendCommand(target, 'Page.enable');
      await chrome.debugger.sendCommand(target, 'Page.setLifecycleEventsEnabled', { enabled: true });
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
        const navigation = await chrome.debugger.sendCommand(target, 'Page.navigate', { url: url.href });
        if (navigation.errorText) throw new Error(navigation.errorText);
        if (navigation.isDownload) throw new Error('The URL triggered a download rather than a page navigation.');
        loaderId = navigation.loaderId;
        if (loaderId && !completed.has(loaderId)) {
          let timer;
          try { await Promise.race([loaded, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Navigation timed out')), 25000); })]); }
          finally { clearTimeout(timer); }
        }
      } finally {
        chrome.debugger.onEvent.removeListener(onEvent);
      }
      return { navigated: url.href };
    }
    if (method === 'browser_screenshot') {
      let image = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 });
      if (image.data.length > 800000) image = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 25 });
      if (image.data.length > 800000) throw new Error('Screenshot is too large; reduce the browser window size and retry.');
      return image;
    }
    if (method === 'browser_key') {
      const special = { Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], ' ': ['Space', 32] };
      const key = params.key;
      const descriptor = typeof key === 'string' && /^[a-z]$/i.test(key) ? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)] : typeof key === 'string' && /^[0-9]$/.test(key) ? [`Digit${key}`, key.charCodeAt(0)] : Object.hasOwn(special, key) ? special[key] : undefined;
      const flags = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
      const modifiers = params.modifiers ?? [];
      if (!descriptor || !Array.isArray(modifiers) || modifiers.some(value => !Object.hasOwn(flags, value)) || new Set(modifiers).size !== modifiers.length) throw new Error('Unsupported key or modifiers');
      const shifted = modifiers.includes('Shift');
      const shiftedDigit = shifted && /^[0-9]$/.test(key) ? ')!@#$%^&*('[Number(key)] : undefined;
      const actualKey = shiftedDigit ?? (shifted && /^[a-z]$/i.test(key) ? key.toUpperCase() : key);
      const event = { key: actualKey, code: descriptor[0], windowsVirtualKeyCode: descriptor[1], modifiers: modifiers.reduce((mask, value) => mask | flags[value], 0) };
      const blockedText = modifiers.some(value => ['Alt', 'Control', 'Meta'].includes(value));
      const text = blockedText ? undefined : key === 'Enter' ? '\r' : shiftedDigit ?? (key.length === 1 ? actualKey : undefined);
      const down = text === undefined ? { ...event, type: 'rawKeyDown' } : { ...event, type: 'keyDown', text, unmodifiedText: text };
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', down);
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
      return { ok: true };
    }
    if (method === 'browser_scroll') {
      const deltaX = params.deltaX ?? 0, deltaY = params.deltaY;
      if (![deltaX, deltaY].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 3000)) throw new Error('Scroll distances must be finite numbers within 3000 pixels');
      const evaluated = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: '({x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2)})', returnByValue: true });
      if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...evaluated.result.value, deltaX, deltaY });
      return { ok: true };
    }
    let expression;
    if (method === 'browser_snapshot') {
      expression = `(() => {
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
    } else if (method === 'browser_click' || method === 'browser_type') {
      if (typeof params.selector !== 'string' || params.selector.length > 2000) throw new Error('A CSS selector is required.');
      if (method === 'browser_type' && (typeof params.text !== 'string' || params.text.length > 20000)) throw new Error('Text is required.');
      expression = `(() => {
        const matches = document.querySelectorAll(${JSON.stringify(params.selector)});
        if (matches.length === 0) throw new Error('Element not found');
        if (matches.length !== 1) throw new Error('Selector matches multiple elements');
        const el = matches[0];
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) throw new Error('Element is not visible');
        el.scrollIntoView({block:'center',inline:'center'});
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
    } else {
      throw new Error('Unknown browser operation');
    }
    const evaluated = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression, returnByValue: true });
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
    const value = evaluated.result.value;
    if (method === 'browser_snapshot') return value;
    if (method === 'browser_click') {
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: value.x, y: value.y, button: 'left', clickCount: 1 });
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: value.x, y: value.y, button: 'left', clickCount: 1 });
    } else {
      await chrome.debugger.sendCommand(target, 'Input.insertText', { text: params.text });
    }
    return { ok: true };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'reconnect') connect();
  if (message.type === 'status' || message.type === 'reconnect') sendResponse({ status });
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.tabs.onRemoved.addListener(async (id) => {
  await chrome.storage.session.set({ sharedTabs: (await sharedTabs()).filter(tab => tab !== id) });
});
connect();
