const status = document.querySelector('#status');
const label = document.querySelector('#tab');
const button = document.querySelector('#toggle');
const reconnect = document.querySelector('#reconnect');
const sharedList = document.querySelector('#shared');
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
label.textContent = tab?.title || 'No current tab';
const canShare = Boolean(tab?.id && /^https?:\/\//i.test(tab.url || ''));
button.disabled = !canShare;
document.querySelector('#unavailable').hidden = canShare;
async function renderShares() {
  const { sharedTabs } = await chrome.storage.session.get({ sharedTabs: [] });
  button.textContent = sharedTabs.includes(tab?.id) ? 'Stop sharing this tab' : 'Share this tab';
  const tabs = (await Promise.all(sharedTabs.map(id => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
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
      const current = (await chrome.storage.session.get({ sharedTabs: [] })).sharedTabs;
      await chrome.storage.session.set({ sharedTabs: current.filter(id => id !== sharedTab.id) });
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
await updateStatus();
await renderShares();
setInterval(updateStatus, 1000);
reconnect.addEventListener('click', () => updateStatus('reconnect'));
button.addEventListener('click', async () => {
  const current = (await chrome.storage.session.get({ sharedTabs: [] })).sharedTabs;
  const next = current.includes(tab.id) ? current.filter(id => id !== tab.id) : [...current, tab.id];
  await chrome.storage.session.set({ sharedTabs: next });
  await renderShares();
});
