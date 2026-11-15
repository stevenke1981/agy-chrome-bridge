const status = document.querySelector('#status');
const label = document.querySelector('#tab');
const button = document.querySelector('#toggle');
const reconnect = document.querySelector('#reconnect');
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const { sharedTabs } = await chrome.storage.session.get({ sharedTabs: [] });
const shared = sharedTabs.includes(tab?.id);
label.textContent = tab?.title || 'No current tab';
button.textContent = shared ? 'Stop sharing this tab' : 'Share this tab';
button.disabled = !tab?.id || !/^https?:\/\//i.test(tab.url || '');
async function updateStatus(type = 'status') {
  const connection = await chrome.runtime.sendMessage({ type });
  status.textContent = `Bridge: ${connection.status}`;
}
await updateStatus();
setInterval(updateStatus, 1000);
reconnect.addEventListener('click', () => updateStatus('reconnect'));
button.addEventListener('click', async () => {
  const current = (await chrome.storage.session.get({ sharedTabs: [] })).sharedTabs;
  const next = current.includes(tab.id) ? current.filter(id => id !== tab.id) : [...current, tab.id];
  await chrome.storage.session.set({ sharedTabs: next });
  window.close();
});
