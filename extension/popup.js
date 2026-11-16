const status = document.querySelector('#status');
const label = document.querySelector('#tab');
const button = document.querySelector('#toggle');
const reconnect = document.querySelector('#reconnect');
const pair = document.querySelector('#pair');
const sharedList = document.querySelector('#shared');
document.querySelector('#version').textContent = `Version ${chrome.runtime.getManifest().version}`;
pair.hidden = Boolean((await chrome.storage.local.get('profileKey')).profileKey);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
label.textContent = tab?.title || 'No current tab';
const canShare = Boolean(tab?.id && /^https?:\/\//i.test(tab.url || ''));
const currentOrigin = canShare ? new URL(tab.url).origin : undefined;
button.disabled = !canShare;
document.querySelector('#unavailable').hidden = canShare;

async function readShares() {
  const { sharedTabs, sharedOrigins } = await chrome.storage.session.get({ sharedTabs: [], sharedOrigins: {} });
  return { sharedTabs, sharedOrigins };
}

function withoutTab(shares, tabId) {
  return {
    sharedTabs: shares.sharedTabs.filter(id => id !== tabId),
    sharedOrigins: Object.fromEntries(Object.entries(shares.sharedOrigins).filter(([id]) => Number(id) !== tabId)),
  };
}

function withTab(shares, tabId, origin) {
  const rest = withoutTab(shares, tabId);
  return { sharedTabs: [...rest.sharedTabs, tabId], sharedOrigins: { ...rest.sharedOrigins, [tabId]: origin } };
}

function isSharedHere(shares) {
  return shares.sharedTabs.includes(tab?.id) && shares.sharedOrigins[tab?.id] === currentOrigin;
}

function shareLabel(shares) {
  if (!shares.sharedTabs.includes(tab?.id)) return 'Share this tab';
  return isSharedHere(shares) ? 'Stop sharing this tab' : 'Share this tab again';
}

async function renderShares() {
  const shares = await readShares();
  button.textContent = shareLabel(shares);
  const tabs = (await Promise.all(shares.sharedTabs.map(id => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  sharedList.replaceChildren();
  if (!tabs.length) {
    const item = document.createElement('li');
    item.textContent = 'No tabs shared';
    sharedList.append(item);
  }
  for (const sharedTab of tabs) {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = sharedTab.title || sharedTab.url || `Tab ${sharedTab.id}`;
    const stop = document.createElement('button');
    stop.textContent = 'Stop sharing';
    stop.setAttribute('aria-label', `Stop sharing ${text.textContent}`);
    stop.addEventListener('click', async () => {
      await chrome.storage.session.set(withoutTab(await readShares(), sharedTab.id));
      await renderShares();
    });
    item.append(text, stop);
    sharedList.append(item);
  }
}
async function updateStatus(type = 'status') {
  const connection = await chrome.runtime.sendMessage({ type });
  status.textContent = `Bridge: ${connection.status}`;
}
function reconnectFromPopup() {
  const probe = new WebSocket('ws://127.0.0.1:38745/bridge');
  probe.onopen = () => { probe.close(); updateStatus('reconnect'); };
  probe.onerror = () => { status.textContent = 'Bridge: start AGY or allow local loopback access'; };
}
await updateStatus();
await renderShares();
setInterval(updateStatus, 1000);
reconnect.addEventListener('click', reconnectFromPopup);
pair.addEventListener('click', async () => {
  const profileKey = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ profileKey });
  pair.hidden = true;
  reconnectFromPopup();
  chrome.runtime.sendMessage({ type: 'reconnect' });
});
button.addEventListener('click', async () => {
  const shares = await readShares();
  const next = isSharedHere(shares) ? withoutTab(shares, tab.id) : withTab(shares, tab.id, currentOrigin);
  await chrome.storage.session.set(next);
  await renderShares();
});
