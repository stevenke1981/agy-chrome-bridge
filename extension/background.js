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
    let expression;
    if (method === 'browser_snapshot') {
      expression = `(() => {
        const path = el => {
          if (el.id) return '#' + CSS.escape(el.id);
          const parts = [];
          for (let node = el; node && node.nodeType === 1 && parts.length < 8; node = node.parentElement) {
            let part = node.localName;
            if (node.parentElement) part += ':nth-child(' + (Array.prototype.indexOf.call(node.parentElement.children, node) + 1) + ')';
            parts.unshift(part);
            if (node.id) { parts[0] = '#' + CSS.escape(node.id); break; }
          }
          return parts.join(' > ');
        };
        const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[contenteditable=true]')].filter(visible).slice(0, 150).map(el => ({selector:path(el),role:el.getAttribute('role') || el.tagName.toLowerCase(),label:(el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').slice(0,200),type:el.getAttribute('type')}));
        return {title:document.title,url:location.href,text:(document.body?.innerText || '').slice(0,30000),elements};
      })()`;
    } else if (method === 'browser_click' || method === 'browser_type') {
      if (typeof params.selector !== 'string' || params.selector.length > 2000) throw new Error('A CSS selector is required.');
      expression = `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (!el) throw new Error('Element not found'); const rect = el.getBoundingClientRect(); if (!rect.width || !rect.height) throw new Error('Element is not visible'); el.scrollIntoView({block:'center',inline:'center'}); el.focus(); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,editable:el.matches('input:not([type=hidden]),textarea,[contenteditable=true]')}; })()`;
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
      if (!value.editable || typeof params.text !== 'string' || params.text.length > 20000) throw new Error('An editable element and text are required.');
      await chrome.debugger.sendCommand(target, 'Input.insertText', { text: params.text });
    }
    return { ok: true };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'status') { connect(); sendResponse({ status }); }
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.tabs.onRemoved.addListener(async (id) => {
  await chrome.storage.session.set({ sharedTabs: (await sharedTabs()).filter(tab => tab !== id) });
});
connect();
