const status = document.querySelector('#status');
const label = document.querySelector('#tab');
const button = document.querySelector('#toggle');
const reconnect = document.querySelector('#reconnect');
const pill = document.querySelector('#pill');
const detail = document.querySelector('#detail');
const sharedList = document.querySelector('#shared');
document.querySelector('#version').textContent = `Version ${chrome.runtime.getManifest().version}`;
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
label.textContent = tab?.title || 'No current tab';
const canShare = Boolean(tab?.id && /^https?:\/\//i.test(tab.url || ''));
const currentOrigin = canShare ? new URL(tab.url).origin : undefined;
button.disabled = !canShare;
document.querySelector('#unavailable').hidden = canShare;
document.querySelector('#origin').textContent = currentOrigin ? new URL(tab.url).host : '';

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

const autoShareSwitch = document.querySelector('#autoShare');
const footer = document.querySelector('footer');
// Auto-share is on unless the user turned it off; it then covers every HTTP(S) tab.
let autoShare = (await chrome.storage.local.get('autoShare')).autoShare !== false;

function emptyItem(text) {
  const item = document.createElement('li');
  item.className = 'empty';
  item.textContent = text;
  return item;
}

async function renderShares() {
  autoShareSwitch.checked = autoShare;
  button.hidden = autoShare;
  if (footer) footer.textContent = autoShare
    ? 'Auto-share is on: AGY can use any HTTP(S) tab in this profile. Turn it off to share tabs one by one.'
    : 'AGY can read and operate only the tabs you share. Sharing ends when Chrome closes.';
  if (autoShare) {
    const unavailable = document.querySelector('#unavailable');
    unavailable.hidden = canShare;
    unavailable.textContent = 'AGY cannot use browser pages such as this one.';
    sharedList.replaceChildren(emptyItem(canShare ? 'All HTTP(S) tabs, including this one' : 'All HTTP(S) tabs'));
    return;
  }
  const shares = await readShares();
  button.textContent = shareLabel(shares);
  button.setAttribute('data-shared', String(isSharedHere(shares)));
  const tabs = (await Promise.all(shares.sharedTabs.map(id => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  sharedList.replaceChildren();
  if (!tabs.length) sharedList.append(emptyItem('No tabs shared'));
  for (const sharedTab of tabs) {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = sharedTab.title || sharedTab.url || `Tab ${sharedTab.id}`;
    const stop = document.createElement('button');
    stop.textContent = '×';
    stop.title = 'Stop sharing';
    stop.setAttribute('aria-label', `Stop sharing ${text.textContent}`);
    stop.addEventListener('click', async () => {
      await chrome.storage.session.set(withoutTab(await readShares(), sharedTab.id));
      await renderShares();
    });
    item.append(text, stop);
    sharedList.append(item);
  }
}
// Maps the background's status text to a headline, a colour state and an optional detail line.
function describe(text) {
  if (text === 'connected') return { headline: 'Connected to AGY', state: 'ok' };
  if (text === 'connecting') return { headline: 'Connecting…', state: 'busy' };
  if (text === 'disconnected' || text?.startsWith('AGY is not running')) return { headline: 'Waiting for AGY', state: 'busy', detail: 'Start AGY CLI or IDE; this connects automatically.' };
  return { headline: 'Not connected', state: 'bad', detail: text };
}
function showStatus(view) {
  // Rewrite only on change so the aria-live region does not re-announce every second.
  if (status.textContent !== view.headline) status.textContent = view.headline;
  pill.setAttribute('data-state', view.state);
  detail.textContent = view.detail || '';
  detail.hidden = !view.detail;
}
async function updateStatus(type = 'status') {
  const connection = await chrome.runtime.sendMessage({ type });
  showStatus(describe(connection.status));
}
function reconnectFromPopup() {
  const probe = new WebSocket('ws://127.0.0.1:38745/bridge');
  probe.onopen = () => { probe.close(); updateStatus('reconnect'); };
  probe.onerror = () => showStatus({ headline: 'Not connected', state: 'bad', detail: 'Start AGY CLI or IDE, or allow local loopback access.' });
}
await updateStatus();
await renderShares();
setInterval(updateStatus, 1000);
reconnect.addEventListener('click', reconnectFromPopup);
autoShareSwitch.addEventListener('change', async () => {
  autoShare = Boolean(autoShareSwitch.checked);
  await chrome.storage.local.set({ autoShare });
  await renderShares();
});
button.addEventListener('click', async () => {
  const shares = await readShares();
  const next = isSharedHere(shares) ? withoutTab(shares, tab.id) : withTab(shares, tab.id, currentOrigin);
  await chrome.storage.session.set(next);
  await renderShares();
});
