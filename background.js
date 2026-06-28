chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INJECT_SCRIPT' && sender.tab && sender.tab.id) {
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id },
        files: ['injected.js'],
        world: 'MAIN'
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[d-op background] injection failed:', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }
  return false;
});
