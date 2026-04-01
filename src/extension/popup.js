const badge = document.getElementById('badge');
const errorText = document.getElementById('error-text');
const relayUrl = document.getElementById('relay-url');
const retryBtn = document.getElementById('retry-btn');

const render = async () => {
  const state = await browser.storage.local.get(['relayConnected', 'relayLastError', 'relayUrl', 'relayLastEvent', 'keepalivePorts']);
  const connected = state.relayConnected === true;
  badge.textContent = connected ? 'Connected' : 'Disconnected';
  badge.className = `badge ${connected ? 'connected' : 'disconnected'}`;
  const lastEvent = state.relayLastEvent ? ` (${state.relayLastEvent})` : '';
  const keepalive = Number.isFinite(state.keepalivePorts) ? ` | keepalive: ${state.keepalivePorts}` : '';
  errorText.textContent = `${state.relayLastError || 'none'}${lastEvent}${keepalive}`;
  relayUrl.textContent = state.relayUrl || 'http://127.0.0.1:1969';
};

retryBtn.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: 'doraemon.retryRelay' });
  await render();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.relayConnected || changes.relayLastError || changes.relayUrl || changes.relayLastEvent || changes.keepalivePorts) {
    void render();
  }
});

await render();
